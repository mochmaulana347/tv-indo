// TV Indo — web IPTV player (statis, tanpa server)
// Playlist: iptv-org (github.io). Player: hls.js + native HLS fallback.
(function () {
  'use strict';

  var SOURCES = {
    id:     { label: 'Indonesia', url: 'https://iptv-org.github.io/iptv/countries/id.m3u' },
    global: { label: 'Global',    url: 'https://iptv-org.github.io/iptv/iptv.m3u' },
  };
  var LS = { src: 'tvindo.source', custom: 'tvindo.customUrl', fav: 'tvindo.favs', epg: 'tvindo.epgUrl' };

  var video = document.getElementById('video');
  var grid = document.getElementById('grid');
  var catList = document.getElementById('catList');
  var chips = document.getElementById('chips');
  var searchEl = document.getElementById('search');
  var statusEl = document.getElementById('status');
  var totalCount = document.getElementById('totalCount');
  var sourceSelect = document.getElementById('sourceSelect');
  var customUrl = document.getElementById('customUrl');
  var epgUrlInput = document.getElementById('epgUrl');
  var playerError = document.getElementById('playerError');
  var playerErrorDetail = document.getElementById('playerErrorDetail');

  var channels = [];        // {name, url, logo, group, tvgId}
  var epg = {};              // tvgId -> [{start, stop, title}]
  var activeCat = 'Semua';
  var activeFavOnly = false;
  var current = null;        // channel yang sedang diputar
  var currentViaProxy = false; // true kalau stream sedang lewat /api/proxy
  var currentLines = [];     // semua URL untuk nama yang sama
  var currentLineIdx = 0;
  var hls = null;

  function proxyUrl(url) { return '/api/proxy?url=' + encodeURIComponent(url); }

  function favs() {
    try { return JSON.parse(localStorage.getItem(LS.fav) || '[]'); } catch (e) { return []; }
  }
  function saveFavs(list) { localStorage.setItem(LS.fav, JSON.stringify(list)); }
  function isFav(ch) { return favs().indexOf(ch.url) !== -1; }
  function toggleFav(ch) {
    var f = favs();
    var i = f.indexOf(ch.url);
    if (i === -1) f.push(ch.url); else f.splice(i, 1);
    saveFavs(f);
    renderCats(); renderGrid(); updateFavBtn();
  }

  // ---------- M3U ----------
  function parseM3U(text) {
    var lines = text.split(/\r?\n/);
    var out = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXTINF:') === 0) {
        var m = line.match(/tvg-id="([^"]*)"/);
        var lg = line.match(/tvg-logo="([^"]*)"/);
        var gp = line.match(/group-title="([^"]*)"/);
        // Nama channel = teks setelah koma PERTAMA yang berada di luar tanda kutip
        // (atribut seperti http-user-agent bisa mengandung koma di dalam kutip)
        var name = '';
        var inQuotes = false;
        for (var k = 0; k < line.length; k++) {
          var ch = line[k];
          if (ch === '"') inQuotes = !inQuotes;
          else if (ch === ',' && !inQuotes) { name = line.slice(k + 1).trim(); break; }
        }
        cur = {
          name: name || 'Tanpa nama',
          tvgId: m ? m[1] : '',
          logo: lg ? lg[1] : '',
          group: gp ? gp[1] : 'Lainnya',
          url: ''
        };
      } else if (line.charAt(0) === '#') {
        continue; // #EXTVLCOPT dsb dilewati
      } else if (cur) {
        cur.url = line;
        if (/^https?:\/\//i.test(cur.url)) out.push(cur);
        cur = null;
      }
    }
    return out;
  }

  // ---------- EPG (XMLTV, opsional) ----------
  function parseEpgXml(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    var map = {};
    var progs = doc.getElementsByTagName('programme');
    for (var i = 0; i < progs.length; i++) {
      var p = progs[i];
      var ch = p.getAttribute('channel');
      var t = p.getElementsByTagName('title')[0];
      if (!ch || !t) continue;
      var item = {
        start: parseXmltvTime(p.getAttribute('start')),
        stop: parseXmltvTime(p.getAttribute('stop')),
        title: t.textContent
      };
      if (!map[ch]) map[ch] = [];
      map[ch].push(item);
    }
    return map;
  }
  function parseXmltvTime(s) {
    if (!s) return 0;
    // format: 20261121090000 +0700
    var m = s.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
    if (!m) return 0;
    var iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + (m[7] ? m[7].slice(0, 3) + ':' + m[7].slice(3) : 'Z');
    var t = Date.parse(iso);
    return isNaN(t) ? 0 : t;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }
  function epgNowNext(tvgId) {
    var list = epg[tvgId];
    if (!list) return null;
    var now = Date.now();
    var cur = null, nxt = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].start <= now && now < list[i].stop) cur = list[i];
      if (list[i].start > now && !nxt) nxt = list[i];
    }
    return { cur: cur, nxt: nxt };
  }
  function updateEpgBox() {
    var box = document.getElementById('npEpg');
    if (!current || !current.tvgId) { box.innerHTML = ''; return; }
    var nn = epgNowNext(current.tvgId);
    if (!nn || (!nn.cur && !nn.nxt)) { box.innerHTML = ''; return; }
    var html = '';
    if (nn.cur) html += '<b>Sekarang:</b> ' + esc(nn.cur.title) + ' (' + fmtTime(nn.cur.start) + '–' + fmtTime(nn.cur.stop) + ')';
    if (nn.nxt) html += (html ? '<br>' : '') + '<b>Berikutnya:</b> ' + esc(nn.nxt.title) + ' (' + fmtTime(nn.nxt.start) + ')';
    box.innerHTML = html;
  }

  // ---------- render ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function groups() {
    var g = {};
    channels.forEach(function (c) { g[c.group] = (g[c.group] || 0) + 1; });
    return g;
  }
  function filtered() {
    var q = searchEl.value.trim().toLowerCase();
    return channels.filter(function (c) {
      if (activeFavOnly && !isFav(c)) return false;
      if (activeCat !== 'Semua' && c.group !== activeCat) return false;
      if (q && c.name.toLowerCase().indexOf(q) === -1 && c.group.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function renderCats() {
    var g = groups();
    var f = favs().length;
    var cats = ['Semua'].concat(Object.keys(g).sort());
    catList.innerHTML = '';
    var favLi = document.createElement('li');
    favLi.innerHTML = '<span>★ Favorit</span><span class="count">' + f + '</span>';
    favLi.className = activeFavOnly ? 'active' : '';
    favLi.onclick = function () { activeFavOnly = true; activeCat = 'Semua'; renderCats(); renderGrid(); };
    catList.appendChild(favLi);
    cats.forEach(function (cat) {
      var li = document.createElement('li');
      li.innerHTML = '<span>' + esc(cat) + '</span><span class="count">' + (cat === 'Semua' ? channels.length : g[cat]) + '</span>';
      li.className = (!activeFavOnly && activeCat === cat) ? 'active' : '';
      li.onclick = function () { activeFavOnly = false; activeCat = cat; renderCats(); renderGrid(); };
      catList.appendChild(li);
    });
    totalCount.textContent = channels.length ? '· ' + channels.length + ' channel' : '';
    // chips (mobile)
    chips.innerHTML = '';
    cats.slice(0, 12).forEach(function (cat) {
      var b = document.createElement('button');
      b.className = 'chip' + ((!activeFavOnly && activeCat === cat) ? ' active' : '');
      b.textContent = cat;
      b.onclick = function () { activeFavOnly = false; activeCat = cat; renderCats(); renderGrid(); };
      chips.appendChild(b);
    });
  }
  function renderGrid() {
    var list = filtered();
    grid.innerHTML = '';
    document.getElementById('gridCount').textContent = list.length ? list.length + ' channel' : '';
    if (!list.length) {
      statusEl.textContent = channels.length
        ? 'Tidak ada channel yang cocok. Coba kata kunci atau kategori lain.'
        : 'Playlist kosong / gagal dimuat.';
      statusEl.hidden = false;
      return;
    }
    statusEl.hidden = true;
    // batasi render 400 kartu biar ringan
    list.slice(0, 400).forEach(function (c) {
      var card = document.createElement('div');
      card.className = 'card' + ((current && current.url === c.url) ? ' playing' : '');
      var logo = c.logo
        ? '<img src="' + esc(c.logo) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
        : '<div style="width:64px;height:40px;display:flex;align-items:center;justify-content:center;font-size:24px">📺</div>';
      card.innerHTML = '<div class="ctop"><span class="fav">' + (isFav(c) ? '★' : '') + '</span></div>'
        + logo
        + '<div class="cname">' + esc(c.name) + '</div>'
        + '<div class="cgroup">' + esc(c.group) + '</div>';
      card.onclick = function () { play(c); };
      grid.appendChild(card);
    });
    if (list.length > 400) {
      statusEl.textContent = 'Menampilkan 400 dari ' + list.length + ' channel — persempit dengan pencarian.';
      statusEl.hidden = false;
    }
  }

  // ---------- player ----------
  function destroyHls() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
  }
  function play(ch, viaProxy) {
    current = ch;
    currentViaProxy = !!viaProxy;
    currentLines = channels.filter(function (c) { return c.name === ch.name; });
    currentLineIdx = Math.max(0, currentLines.indexOf(ch));
    playerError.hidden = true;
    document.getElementById('liveBadge').hidden = false;
    destroyHls();
    var url = viaProxy ? proxyUrl(ch.url) : ch.url;
    document.getElementById('npName').textContent = ch.name;
    document.getElementById('npMeta').textContent = ch.group + (ch.tvgId ? ' · ' + ch.tvgId : '') + (viaProxy ? ' · via proxy' : '');
    var logoEl = document.getElementById('npLogo');
    if (ch.logo) { logoEl.src = ch.logo; logoEl.hidden = false; } else { logoEl.hidden = true; }
    renderLineBox();
    updateFavBtn();
    updateEpgBox();
    renderGrid();

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () { video.play().catch(function () {}); });
      hls.on(Hls.Events.ERROR, function (ev, data) {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (!viaProxy) {
            // Direct gagal (CORS / mixed content / mati) -> coba lewat proxy.
            document.getElementById('npMeta').textContent = 'Mencoba lewat proxy…';
            setTimeout(function () { play(current, true); }, 100);
          } else {
            showPlayerError('Server stream menolak koneksi dari browser (kemungkinan CORS) atau sedang mati. Proxy juga gagal.');
          }
        } else {
          showPlayerError('Format stream tidak didukung (' + (data.details || data.type) + ').');
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.play().catch(function () {}); // gagal jaringan ditangani listener 'error' di bawah
    } else {
      showPlayerError('Browser ini tidak mendukung HLS.');
    }
    video.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function showPlayerError(msg) {
    playerErrorDetail.textContent = msg;
    playerError.hidden = false;
    document.getElementById('liveBadge').hidden = true;
  }
  function renderLineBox() {
    var box = document.getElementById('lineBox');
    if (currentLines.length <= 1) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<span>Line:</span>';
    currentLines.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'btn small' + (i === currentLineIdx ? ' active' : '');
      b.style.width = 'auto';
      b.textContent = 'L' + (i + 1);
      b.onclick = function () { currentLineIdx = i; play(c); };
      box.appendChild(b);
    });
  }
  function updateFavBtn() {
    var b = document.getElementById('favBtn');
    if (!current) { b.textContent = '☆ Favorit'; b.classList.remove('faved'); return; }
    var f = isFav(current);
    b.textContent = f ? '★ Favorit' : '☆ Favorit';
    b.classList.toggle('faved', f);
  }

  // ---------- load playlist ----------
  function playlistUrl() {
    var q = new URLSearchParams(location.search).get('src');
    if (q) return q;
    var sel = sourceSelect.value;
    if (sel === 'custom') return customUrl.value.trim();
    return SOURCES[sel].url;
  }
  function loadPlaylist() {
    var url = playlistUrl();
    if (!url) { statusEl.textContent = 'Masukkan URL playlist .m3u dulu.'; statusEl.hidden = false; return; }
    statusEl.textContent = 'Memuat playlist…';
    statusEl.hidden = false;
    grid.innerHTML = '';
    // skeleton loading biar kelihatan hidup
    var sk = '';
    for (var s = 0; s < 12; s++) sk += '<div class="card skeleton"><div class="sk-logo"></div><div class="sk-line"></div><div class="sk-line short"></div></div>';
    grid.innerHTML = sk;
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (text) {
        channels = parseM3U(text);
        activeCat = 'Semua'; activeFavOnly = false;
        renderCats(); renderGrid();
        statusEl.textContent = channels.length
          ? 'Playlist dimuat: ' + channels.length + ' channel. Klik salah satu untuk nonton.'
          : 'Playlist kosong.';
        statusEl.hidden = channels.length > 0;
      })
      .catch(function (err) {
        statusEl.textContent = 'Gagal memuat playlist (' + err.message + '). Coba ganti sumber atau cek koneksi.';
        statusEl.hidden = false;
      });
  }

  // ---------- EPG load ----------
  function loadEpg() {
    var url = epgUrlInput.value.trim();
    if (!url) return;
    localStorage.setItem(LS.epg, url);
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (text) {
        epg = parseEpgXml(text);
        updateEpgBox();
        statusEl.textContent = 'EPG dimuat (' + Object.keys(epg).length + ' channel punya jadwal).';
        statusEl.hidden = false;
        setTimeout(function () { statusEl.hidden = true; }, 4000);
      })
      .catch(function () {
        statusEl.textContent = 'Gagal memuat EPG — URL mungkin salah / tidak mengizinkan CORS.';
        statusEl.hidden = false;
      });
  }

  // ---------- events ----------
  searchEl.addEventListener('input', renderGrid);
  sourceSelect.addEventListener('change', function () {
    var isCustom = sourceSelect.value === 'custom';
    customUrl.hidden = !isCustom;
    localStorage.setItem(LS.src, sourceSelect.value);
    if (!isCustom) loadPlaylist();
    else customUrl.focus();
  });
  customUrl.addEventListener('change', function () {
    localStorage.setItem(LS.custom, customUrl.value.trim());
    loadPlaylist();
  });
  document.getElementById('favBtn').addEventListener('click', function () {
    if (current) toggleFav(current);
  });
  document.getElementById('retryBtn').addEventListener('click', function () {
    if (current) play(current);
  });
  document.getElementById('copyUrlBtn').addEventListener('click', function () {
    if (!current) return;
    var done = function () { document.getElementById('copyUrlBtn').textContent = '✓ Disalin!'; setTimeout(function () { document.getElementById('copyUrlBtn').textContent = '📋 Salin URL stream'; }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(current.url).then(done, done);
    else { var t = document.createElement('textarea'); t.value = current.url; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(t); done(); }
  });
  document.getElementById('epgBtn').addEventListener('click', loadEpg);
  video.addEventListener('error', function () {
    if (!video.error) return;
    if (hls) return; // kalau hls.js aktif, error ditangani handler Hls.Events.ERROR
    if (!current) { showPlayerError('Video error: ' + (video.error.message || video.error.code)); return; }
    if (!currentViaProxy) {
      document.getElementById('npMeta').textContent = 'Mencoba lewat proxy…';
      setTimeout(function () { play(current, true); }, 100);
    } else {
      showPlayerError('Server stream menolak koneksi dari browser (kemungkinan CORS) atau sedang mati. Proxy juga gagal.');
    }
  });

  // ---------- init ----------
  var savedSrc = localStorage.getItem(LS.src);
  if (savedSrc && (SOURCES[savedSrc] || savedSrc === 'custom')) sourceSelect.value = savedSrc;
  var savedCustom = localStorage.getItem(LS.custom);
  if (savedCustom) customUrl.value = savedCustom;
  customUrl.hidden = sourceSelect.value !== 'custom';
  var savedEpg = localStorage.getItem(LS.epg);
  if (savedEpg) { epgUrlInput.value = savedEpg; loadEpg(); }
  loadPlaylist();
})();
