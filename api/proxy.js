// TV Indo stream proxy — Vercel serverless function (Node).
// Merelay manifest (.m3u8) & segmen stream lewat domain sendiri supaya browser
// tidak kena CORS / mixed content. Dipakai HANYA sebagai fallback saat direct
// play gagal (lihat app.js: play() -> failover ke /api/proxy?url=...).
// Bukan proxy umum:
//  - hanya host publik (blokir IP privat / loopback / metadata — anti SSRF)
//  - hanya ekstensi stream umum (atau tanpa ekstensi); file lain ditolak
//  - batas waktu upstream 8 detik (limit fungsi Vercel Hobby 10 detik)
//  - TVINDO_PROXY_ALLOW_LOCAL=1 HANYA untuk tes lokal; jangan pernah di-set di Vercel.
const ALLOWED_EXT = new Set(['.m3u8', '.ts', '.m4s', '.mp4', '.mpd', '.aac', '.m4a', '.key', '.cmfv', '.cmfa', '.mp3', '.wav']);
const UPSTREAM_TIMEOUT_MS = 8000;
const PROXY_BASE = '/api/proxy?url=';

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h === 'metadata.google.internal') return true;
  if (h === '::1') return true;
  if (/^10\./.test(h) || /^127\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h) || /^0\./.test(h)) return true;
  if (/^fc00:/.test(h) || /^fd00:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

function isAllowedTarget(u) {
  if (!/^https?:$/i.test(u.protocol)) return false;
  if (isPrivateHost(u.hostname)) {
    // tes lokal saja: izinkan 127.0.0.1 kalau flag test disetel
    if (!(process.env.TVINDO_PROXY_ALLOW_LOCAL === '1' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) return false;
  }
  const path = u.pathname.toLowerCase();
  const dot = path.lastIndexOf('.');
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
  if (ext && !ALLOWED_EXT.has(ext)) return false;
  return true;
}

function rewriteManifest(text, targetUrl) {
  const lines = text.split(/\r?\n/);
  return lines.map((line) => {
    // Atribut URI="..." (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, ...)
    if (line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (whole, uri) => {
        let abs;
        try { abs = new URL(uri, targetUrl).toString(); } catch (e) { return whole; }
        return 'URI="' + PROXY_BASE + encodeURIComponent(abs) + '"';
      });
    }
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    // Baris URI (playlist varian / segmen), relatif atau absolut.
    // WAJIB ditulis ulang absolut lewat proxy: kalau dibiarkan relatif, hls.js
    // akan resolve terhadap URL proxy (/api/proxy?url=...) dan hasilnya salah.
    let abs;
    try { abs = new URL(t, targetUrl).toString(); } catch (e) { return line; }
    return PROXY_BASE + encodeURIComponent(abs);
  }).join('\n');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'range, content-type');
  res.setHeader('Access-Control-Expose-Headers', 'content-length, content-range, accept-ranges, content-type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }

  const raw = req.query && req.query.url;
  if (!raw || typeof raw !== 'string') { res.statusCode = 400; res.end('Missing ?url='); return; }

  let target;
  try { target = new URL(raw); } catch (e) { res.statusCode = 400; res.end('Bad url'); return; }
  if (!isAllowedTarget(target)) { res.statusCode = 400; res.end('URL tidak diizinkan'); return; }

  let upstream;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    const headers = { accept: req.headers.accept || '*/*', 'user-agent': 'TVIndo/1.0 (+https://tv-indo-three.vercel.app)' };
    if (req.headers.range) headers.range = req.headers.range;
    upstream = await fetch(target.toString(), { headers, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(timer);
  } catch (e) {
    res.statusCode = 502;
    res.end('Upstream gagal: ' + (e && e.name === 'AbortError' ? 'timeout' : 'tidak bisa dihubungi'));
    return;
  }

  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  const maybeManifest = ct.includes('mpegurl') || /\.m3u8(\?|$)/i.test(target.pathname);

  if (maybeManifest) {
    let text;
    try { text = await upstream.text(); } catch (e) { res.statusCode = 502; res.end('Gagal baca manifest'); return; }
    if (text.trimStart().startsWith('#EXTM3U')) {
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(rewriteManifest(text, target.toString()));
    } else {
      // Server mengembalikan bukan-manifest (mis. halaman error HTML) — teruskan
      // apa adanya, JANGAN di-rewrite (dulu halaman HTML ikut ditulis ulang jadi sampah).
      res.statusCode = upstream.status;
      if (ct) res.setHeader('Content-Type', upstream.headers.get('content-type'));
      res.end(text);
    }
    return;
  }

  // Segmen / file biner: teruskan status + header relevan, streaming body.
  res.statusCode = upstream.status;
  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  for (const h of pass) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) { res.end(); return; }
  try {
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  }
};

// Helper diekspor untuk unit test lokal (bukan bagian dari API publik).
module.exports._test = { isPrivateHost, isAllowedTarget, rewriteManifest };
