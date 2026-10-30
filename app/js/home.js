/*
 * Glass Home - home screen.
 *
 * Remote keys (no registration needed): Left/Right move along the dock (no
 * wrap), OK opens, holding OK for 0.7 s opens a small menu (Move left, Move
 * right, Remove or Hide, Cancel), Back closes menus and does nothing at the
 * top level. While the app is hidden (another app in front) every timer and
 * animation is paused.
 */
(function () {
  'use strict';
  var GH = window.GH;
  var cfg = GH.config;
  var P = GH.platform;
  var D = GH.data;
  var Q = GH.query;
  var ls = GH.ls;
  var $ = function (id) { return document.getElementById(id); };

  // Dock geometry. Tiles are 156 px; with more than 9 items they shrink to no
  // less than 140 px, and past that the row scrolls (edges fade).
  var TILE_MAX = 156;
  var TILE_MIN = 140;
  var PADX = 28;                     // visual glass padding left/right
  var PADY = 26;
  var EDGE = 16;                     // room inside the clip for the enlarged tile
  var MAX_ROW = 1920 - 2 * (92 + PADX);
  var DOCK_BOTTOM = 150;
  var TILE = TILE_MAX;
  var GAP = 28;
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8 };
  var YT_MODES = ['payload', 'uri', 'both'];
  var YT_MODE_NAMES = { payload: 'Smart Hub payload', uri: 'watch URL', both: 'payload + URL' };

  var stage = $('stage');
  var dock = $('dock');
  var viewport = $('dock-viewport');
  var row = $('dock-row');
  var label = $('label');
  var menu = $('menu');
  var panel = $('panel');
  var scrim = $('scrim');

  // Older-TV switches (config.js). ?photoService=0 tries the first in preview.
  var photoService = cfg.photoService !== false && Q.photoService !== '0';
  var smartHubLaunch = cfg.smartHubLaunch === true;

  var defs = cfg.apps;
  var defByKey = {};
  defs.forEach(function (d) { defByKey[d.key] = d; });

  var apps = {};
  var shortcuts = [];
  var items = [];
  var tileEls = {};
  var focus = 0;
  var focusKey = null;              // the tile the viewer chose; survives dock rebuilds
  var offset = 0;
  var mode = 'dock';
  var menuItems = [];
  var menuFocus = 0;
  var panelButtons = [];
  var panelFocus = 0;
  var panelRowFocus = 0;
  var confirmNewPw = 0;
  var waitEnterRelease = false;
  var releaseTimer = null;
  var enterDown = false;
  var longTimer = null;
  var longFired = false;
  var backdrop = null;
  var bundled = [];
  var serviceUp = null;
  var serviceError = null;
  var ensuring = false;
  var clockTimer = null;
  var pollTimer = null;
  var retryTimer = null;
  var storage = null;
  var hidden = ls.get('gh.hidden') || [];
  var appOrder = ls.get('gh.appOrder') || [];
  var inputOrder = ls.get('gh.inputOrder') || [];
  var ytMode = ls.get('gh.ytMode') || cfg.youtubeMode;
  if (YT_MODES.indexOf(ytMode) < 0) ytMode = 'payload';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function div(cls, text) {
    var e = document.createElement('div');
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- desktop preview: fit the 1920x1080 stage to the window ----------
  function fitStage() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    if (w === 1920 && h === 1080) { stage.style.transform = ''; return; }
    var s = Math.min(w / 1920, h / 1080);
    stage.style.transform = 'translate(' + Math.round((w - 1920 * s) / 2) + 'px, ' + Math.round((h - 1080 * s) / 2) + 'px) scale(' + s + ')';
  }

  // ---------- toast ----------
  var toastTimer = null;
  function toast(text, ms) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, ms || 3200);
  }

  // ---------- clock: "3:45 pm" and "Tuesday 21 October" ----------
  var timeFmt = null;
  var dateFmt = null;
  try {
    timeFmt = new Intl.DateTimeFormat(cfg.locale || undefined, { hour: 'numeric', minute: '2-digit' });
    dateFmt = new Intl.DateTimeFormat(cfg.locale || undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  } catch (e) { /* very old engine: fallback below */ }

  function renderClock() {
    var now = new Date();
    var main = '';
    var period = '';
    var dateText = '';
    if (timeFmt && timeFmt.formatToParts) {
      timeFmt.formatToParts(now).forEach(function (p) {
        if (p.type === 'dayPeriod') period = p.value.replace(/\./g, '').toLowerCase();
        else if (p.type === 'hour' || p.type === 'minute' || (p.type === 'literal' && p.value.indexOf(':') >= 0)) main += p.value;
      });
      var parts = {};
      dateFmt.formatToParts(now).forEach(function (p) { parts[p.type] = p.value; });
      dateText = [parts.weekday, parts.day, parts.month].join(' ');
    } else {
      var h = now.getHours();
      main = ((h % 12) || 12) + ':' + ('0' + now.getMinutes()).slice(-2);
      period = h < 12 ? 'am' : 'pm';
      dateText = now.toDateString();
    }
    var t = $('time');
    t.textContent = main.trim();
    if (period) { var s = document.createElement('span'); s.className = 'ampm'; s.textContent = period; t.appendChild(s); }
    $('date').textContent = dateText;
  }

  // ---------- dock model ----------
  function orderedAppKeys() {
    var keys = [];
    appOrder.forEach(function (k) { if (defByKey[k] && keys.indexOf(k) < 0) keys.push(k); });
    defs.forEach(function (d) { if (keys.indexOf(d.key) < 0) keys.push(d.key); });
    return keys;
  }

  // HDMI inputs from config.js, in the order chosen with Move left/right;
  // inputs not moved yet follow, in config order. (?inputs=1 shows two sample
  // inputs in preview.)
  var inputDefs = cfg.preview && Q.inputs === '1'
    ? [{ hdmi: 2, label: 'Games console' }, { hdmi: 3, label: 'Blu-ray' }]
    : (cfg.inputs || []);
  function inputKey(inp) { return inp.tv ? 'in:tv' : 'in:' + inp.hdmi; }
  function orderedInputs() {
    // Ranked from the unsorted list: older engines sort in place, so indexOf
    // on the array being sorted can move under the comparator.
    function rank(inp) {
      var i = inputOrder.indexOf(inputKey(inp));
      return i < 0 ? inputOrder.length + inputDefs.indexOf(inp) : i;
    }
    return inputDefs.slice().sort(function (a, b) { return rank(a) - rank(b); });
  }

  function buildItems() {
    var list = [];
    orderedAppKeys().forEach(function (k) {
      var a = apps[k];
      // Hidden apps come back from +, so without the photo service (no +)
      // nothing stays hidden.
      if (!a || (photoService && hidden.indexOf(k) >= 0)) return;
      list.push({ kind: 'app', key: 'app:' + k, appKey: k, label: defByKey[k].label, id: a.id,
        storeId: defByKey[k].storeId,
        icon: defByKey[k].icon === false ? null : (defByKey[k].icon || P.iconUrl(a.iconPath)) });
    });
    orderedInputs().forEach(function (inp) {
      var k = inputKey(inp);
      if (photoService && hidden.indexOf(k) >= 0) return;    // as for apps
      list.push({ kind: 'input', key: k, appKey: k, label: inp.label, hdmi: inp.hdmi, tv: !!inp.tv, icon: inp.icon || null });
    });
    if (!photoService) return list;
    shortcuts.forEach(function (s) {
      list.push({
        kind: s.type === 'youtube' ? 'youtube' : 'web', key: 'sc:' + s.id, scId: s.id, label: s.name, url: s.url,
        videoId: s.videoId, playlistId: s.playlistId, start: s.start,
        icon: s.icon ? D.media(s.icon) : null, iconW: s.iconW || 0
      });
    });
    list.push({ kind: 'add', key: 'add', label: 'Add photos and shortcuts' });
    return list;
  }

  function signature(it) {
    return [it.kind, it.label, it.icon || '', it.videoId || '', it.iconW || 0].join('|');
  }

  function hueFor(seed) {
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    var hues = [196, 172, 214, 252, 328, 18, 38, 146];
    return hues[h % hues.length];
  }

  function hostOf(url) {
    var m = /^[a-z]+:\/\/(?:www\.)?([^\/?#:]+)/i.exec(url || '');
    return m ? m[1].toLowerCase() : '';
  }

  function monogram(face, it) {
    face.textContent = '';
    var hue = hueFor(hostOf(it.url) || it.label || '');
    face.style.background = 'linear-gradient(150deg, hsl(' + hue + ', 52%, 44%) 0%, hsl(' + ((hue + 28) % 360) + ', 58%, 22%) 100%)';
    var letter = String(it.label || hostOf(it.url) || '?').trim().charAt(0).toUpperCase();
    face.appendChild(div('monogram', letter));
  }

  // Looks at a site icon's corners and brightness so a transparent dark logo
  // gets a light plate and a transparent light logo stays on glass.
  function plateFor(img, face) {
    try {
      var c = document.createElement('canvas');
      c.width = 24; c.height = 24;
      var x = c.getContext('2d');
      x.drawImage(img, 0, 0, 24, 24);
      var d = x.getImageData(0, 0, 24, 24).data;
      var corners = [0, 23 * 4, 23 * 24 * 4, (23 * 24 + 23) * 4];
      var transparent = corners.some(function (i) { return d[i + 3] < 200; });
      if (!transparent) return;
      var sum = 0;
      var n = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        n += 1;
      }
      face.classList.add(n && sum / n < 110 ? 'plate-light' : 'plate-glass');
    } catch (e) { /* cross-origin or decode issue: leave as is */ }
  }

  function youTubeThumb(img, videoId, onFail) {
    var sizes = ['maxresdefault', 'hq720', 'sddefault', 'hqdefault'];
    var i = 0;
    function next() {
      if (i >= sizes.length) { onFail(); return; }
      img.src = 'https://i.ytimg.com/vi/' + videoId + '/' + sizes[i++] + '.jpg';
    }
    img.onerror = next;
    img.onload = function () { if (img.naturalWidth <= 120) next(); };
    next();
  }

  function plusGlyph() {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 48 48');
    s.setAttribute('class', 'plus');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M24 10v28M10 24h28');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '3.2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('fill', 'none');
    s.appendChild(p);
    return s;
  }

  function makeTile(it) {
    var el = div('tile tile-' + it.kind);
    el.appendChild(div('glow'));
    var face = div('face');
    el.appendChild(face);
    var img;
    if (it.kind === 'app') {
      if (it.icon) {
        img = new Image();
        img.className = 'app-icon';
        img.alt = '';
        img.onerror = function () { face.textContent = ''; face.appendChild(div('name-fallback', it.label)); };
        img.src = it.icon;
        face.appendChild(img);
      } else {
        face.appendChild(div('name-fallback', it.label));
      }
    } else if (it.kind === 'web') {
      if (it.icon) {
        img = new Image();
        img.alt = '';
        img.crossOrigin = 'anonymous';
        img.className = it.iconW && it.iconW < 120 ? 'site-icon small' : 'site-icon';
        img.onload = function () { plateFor(img, face); };
        img.onerror = function () { monogram(face, it); };
        img.src = it.icon;
        face.appendChild(img);
      } else {
        monogram(face, it);
      }
    } else if (it.kind === 'youtube') {
      img = new Image();
      img.alt = '';
      img.className = 'thumb';
      face.appendChild(img);
      var fail = function () { face.classList.add('no-thumb'); img.remove(); face.insertBefore(div('name-fallback', it.label), face.firstChild); };
      if (it.icon) {
        img.onerror = function () { if (it.videoId) youTubeThumb(img, it.videoId, fail); else fail(); };
        img.src = it.icon;
      } else if (it.videoId) {
        youTubeThumb(img, it.videoId, fail);
      } else {
        fail();
      }
      face.appendChild(div('play'));
    } else if (it.kind === 'input') {
      if (it.icon) {
        img = new Image();
        img.className = 'input-icon';
        img.alt = '';
        img.onerror = function () { img.remove(); face.insertBefore(div('name-fallback', it.label), face.firstChild); };
        img.src = it.icon;
        face.appendChild(img);
      } else {
        face.appendChild(div('name-fallback', it.label));
      }
      if (!it.tv) face.appendChild(div('input-port', 'HDMI ' + it.hdmi));   // no port caption on Live TV
    } else {
      face.appendChild(plusGlyph());
    }
    face.appendChild(div('sheen'));
    return el;
  }

  function rebuildDock(keepKey) {
    var wanted = keepKey || focusKey;
    items = buildItems();
    var seen = {};
    var els = items.map(function (it) {
      var sig = signature(it);
      var cur = tileEls[it.key];
      if (!cur || cur.sig !== sig) {
        cur = { el: makeTile(it), sig: sig };
        tileEls[it.key] = cur;
      }
      seen[it.key] = true;
      return cur.el;
    });
    Object.keys(tileEls).forEach(function (k) { if (!seen[k]) delete tileEls[k]; });
    // Touch the DOM only when the row really changed: moving an element
    // restarts its CSS animations (the focus sheen would replay on every sync).
    var same = row.children.length === els.length;
    for (var c = 0; same && c < els.length; c++) same = row.children[c] === els[c];
    if (!same) {
      var frag = document.createDocumentFragment();
      els.forEach(function (el) { frag.appendChild(el); });
      row.textContent = '';
      row.appendChild(frag);
    }
    var idx = -1;
    for (var i = 0; i < items.length; i++) if (items[i].key === wanted) { idx = i; break; }
    setFocus(idx >= 0 ? idx : clamp(focus, 0, items.length - 1), true);
  }

  function sizeFor(n) {
    if (n * TILE_MAX + (n - 1) * 28 <= MAX_ROW) return { tile: TILE_MAX, gap: 28 };
    var tile = Math.floor((MAX_ROW - (n - 1) * 24) / n);
    return { tile: Math.max(TILE_MIN, Math.min(TILE_MAX, tile)), gap: 24 };
  }

  function applySize(n) {
    var sz = sizeFor(n);
    if (sz.tile === TILE && sz.gap === GAP && dock.style.getPropertyValue('--tile')) return;
    TILE = sz.tile;
    GAP = sz.gap;
    dock.style.setProperty('--tile', TILE + 'px');
    dock.style.setProperty('--gap', GAP + 'px');
    dock.style.setProperty('--tile-radius', Math.round(TILE * 0.192) + 'px');
  }

  function dockHeight() { return TILE + 2 * PADY; }

  function layoutDock() {
    var n = items.length;
    applySize(n);
    var rowW = n * TILE + (n - 1) * GAP;
    var viewW = Math.min(rowW, MAX_ROW);
    viewport.style.width = (viewW + 2 * EDGE) + 'px';
    var x = focus * (TILE + GAP);
    var scrolling = rowW > MAX_ROW;
    if (!scrolling) offset = 0;
    else {
      var margin = TILE * 0.75;
      if (x - offset < margin) offset = x - margin;
      if (x + TILE - offset > viewW - margin) offset = x + TILE - viewW + margin;
      offset = clamp(offset, 0, rowW - viewW);
    }
    row.style.transform = 'translate3d(' + (-offset) + 'px, 0, 0)';
    dock.classList.toggle('scrolling', scrolling);
    dock.classList.toggle('fade-left', scrolling && offset > 1);
    dock.classList.toggle('fade-right', scrolling && offset < rowW - viewW - 1);
    var dockW = viewW + 2 * PADX;
    var cx = (1920 - dockW) / 2 + PADX + x - offset + TILE / 2;
    // centred under the tile, but never off the screen (long video titles)
    var lw = label.offsetWidth || 0;
    var left = clamp(cx - lw / 2, 72, 1920 - 72 - lw);
    label.style.transform = 'translate3d(' + Math.round(left) + 'px, 0, 0)';
    return cx;
  }

  function setFocus(i, quiet) {
    if (!items.length) return;
    i = clamp(i, 0, items.length - 1);
    focus = i;
    items.forEach(function (it, idx) {
      var t = tileEls[it.key];
      if (t) t.el.classList.toggle('focused', idx === focus);
    });
    var text = items[focus].label;
    if (label.textContent !== text) label.textContent = text;
    if (mode === 'dock') label.classList.add('on');
    layoutDock();
    if (!quiet) {
      focusKey = items[focus].key;
      ls.set('gh.focus', focusKey);
    }
  }

  // ---------- opening things ----------
  // smartHubLaunch (older TVs): the photos and dock are hidden while an app
  // starts, to free graphics memory (on a 2018 TV Netflix and Prime Video fail
  // to start while they hold it). They come back when Glass Home is on screen
  // again, if the launch fails, or after 8 s if the app never appears.
  var launchGuard = null;
  function setLaunching(on) {
    clearTimeout(launchGuard);
    document.documentElement.classList.toggle('launching', on);
    if (!on) return;
    if (backdrop) backdrop.pause();
    launchGuard = setTimeout(function () {
      if (!document.hidden) { setLaunching(false); if (backdrop) backdrop.resume(); }
    }, 8000);
  }

  function activate(it) {
    if (!it) return;
    if (it.kind === 'add') { openPanel(); return; }
    var p;
    var viaSmartHub = it.kind === 'app' && smartHubLaunch;
    if (viaSmartHub && !cfg.preview) setLaunching(true);
    if (it.kind === 'app') p = P.launchApp(it.id, viaSmartHub ? it.storeId : null);
    else if (it.kind === 'input') p = P.switchInput(it.tv ? 'TV' : it.hdmi);
    else if (it.kind === 'web') p = P.openUrl(it.url);
    else p = P.openYouTube(it, ytMode);
    p.then(function (how) {
      if (String(how).indexOf('preview:') === 0) toast('Preview: would open ' + it.label);
      else if (how === 'youtube-home') toast('YouTube opened, but not at this video');
      else if (how === 'browser-home') toast('The browser opened without the address');
    }, function (e) {
      if (viaSmartHub) { setLaunching(false); if (backdrop && !document.hidden) backdrop.resume(); }
      toast('Couldn’t open ' + it.label + (e && e.message ? ' (' + e.message + ')' : ''), 4500);
    });
  }

  // ---------- long-press menu ----------
  function groupOf(it) {
    if (it.kind === 'app' || it.kind === 'input') return items.filter(function (x) { return x.kind === it.kind; });
    return items.filter(function (x) { return x.kind === 'web' || x.kind === 'youtube'; });
  }

  function openMenu() {
    var it = items[focus];
    if (!it || it.kind === 'add') return;
    var group = groupOf(it);
    var gi = group.indexOf(it);
    menuItems = [
      { label: 'Move left', disabled: gi <= 0, run: function () { moveItem(it, -1); } },
      { label: 'Move right', disabled: gi >= group.length - 1, run: function () { moveItem(it, 1); } },
      it.kind === 'web' || it.kind === 'youtube' ? { label: 'Remove', run: function () { removeShortcut(it); } }
        : photoService ? { label: 'Hide', run: function () { hideApp(it); } }
        : null,                           // apps and inputs: no + to bring them back
      { label: 'Cancel', run: function () {} }
    ].filter(Boolean);
    menuFocus = 0;
    while (menuItems[menuFocus].disabled) menuFocus += 1;
    menu.textContent = '';
    menu.appendChild(div('menu-title', it.label));
    menuItems.forEach(function (m) {
      var e = div('menu-item' + (m.disabled ? ' disabled' : ''), m.label);
      m.el = e;
      menu.appendChild(e);
    });
    renderMenuFocus();
    var cx = layoutDock();
    var w = menu.offsetWidth || 340;
    menu.style.left = Math.round(clamp(cx - w / 2, 48, 1920 - 48 - w)) + 'px';
    menu.style.bottom = (DOCK_BOTTOM + dockHeight() + 18) + 'px';
    mode = 'menu';
    menu.classList.add('open');
    dock.classList.add('dimmed');
  }

  function renderMenuFocus() {
    menuItems.forEach(function (m, i) { m.el.classList.toggle('focused', i === menuFocus); });
  }

  function closeMenu() {
    menu.classList.remove('open');
    dock.classList.remove('dimmed');
    mode = 'dock';
  }

  function moveItem(it, dir) {
    var group = groupOf(it);
    var gi = group.indexOf(it);
    var gj = gi + dir;
    if (gj < 0 || gj >= group.length) return;
    if (it.kind === 'app') {
      var keys = group.map(function (x) { return x.appKey; });
      var t = keys[gi]; keys[gi] = keys[gj]; keys[gj] = t;
      var full = orderedAppKeys().filter(function (k) { return keys.indexOf(k) < 0; });
      appOrder = keys.concat(full);
      ls.set('gh.appOrder', appOrder);
      rebuildDock(it.key);
      return;
    }
    if (it.kind === 'input') {
      var ins = group.map(function (x) { return x.key; });
      var u = ins[gi]; ins[gi] = ins[gj]; ins[gj] = u;
      inputOrder = ins;
      ls.set('gh.inputOrder', inputOrder);
      rebuildDock(it.key);
      return;
    }
    var ids = shortcuts.map(function (s) { return s.id; });
    var a = ids.indexOf(it.scId);
    var b = a + dir;
    var before = shortcuts.slice();
    var tmp = shortcuts[a]; shortcuts[a] = shortcuts[b]; shortcuts[b] = tmp;
    rebuildDock(it.key);
    D.orderShortcuts(shortcuts.map(function (s) { return s.id; })).catch(function () {
      shortcuts = before;
      rebuildDock(it.key);
      toast('Couldn’t save the new order. Is the photo service running?');
    });
  }

  function hideApp(it) {
    if (hidden.indexOf(it.appKey) < 0) hidden.push(it.appKey);
    ls.set('gh.hidden', hidden);
    rebuildDock();
    toast(it.label + ' hidden. Show it again from + on the dock.');
  }

  function removeShortcut(it) {
    D.removeShortcut(it.scId).then(function () {
      shortcuts = shortcuts.filter(function (s) { return s.id !== it.scId; });
      rebuildDock();
      toast(it.label + ' removed');
    }, function () { toast('Couldn’t remove it. Is the photo service running?'); });
  }

  // ---------- + panel ----------
  function storageText() {
    if (!storage || !storage.available) return '';
    return (storage.available / 1e9).toFixed(1) + ' GB free on the TV';
  }

  function renderPanel() {
    var st = D.cached();
    var lan = st && st.lan;
    var url = lan && lan.url;
    $('panel-url').textContent = url || (serviceUp === false ? 'Not running yet' : 'Starting…');
    var pw = D.passwordView();
    $('panel-pw').textContent = pw.text || '—';
    $('panel-pw-note').textContent = pw.note || '';
    var users = (st && st.photos ? st.photos.length : 0);
    var scs = shortcuts.length;
    var bits = [bundled.length + ' nature photos', users + (users === 1 ? ' of your photos' : ' of yours'), scs + (scs === 1 ? ' shortcut' : ' shortcuts')];
    var free = storageText();
    if (free) bits.push(free);
    $('panel-stats').textContent = bits.join('  ·  ');

    panelButtons = [];
    panelButtons.push({ id: 'newpw', label: confirmNewPw ? 'Press OK again to confirm' : 'New password', cls: confirmNewPw ? 'armed' : '' });
    if (hidden.length) panelButtons.push({ id: 'unhide', label: 'Show hidden apps (' + hidden.length + ')' });
    panelButtons.push({ id: 'close', label: 'Done' });
    panelButtons.push({ id: 'ytmode', label: 'YouTube links: ' + YT_MODE_NAMES[ytMode], small: true });
    panelFocus = clamp(panelFocus, 0, panelButtons.length - 1);
    panelRowFocus = clamp(panelRowFocus, 0, panelButtons.length - 2);

    var wrap = $('panel-buttons');
    wrap.textContent = '';
    var diag = $('panel-diag');
    diag.textContent = '';
    var svc = st && st.service;
    var line;
    if (serviceUp && svc) {
      line = 'Photo website running · ' + svc.node + ' (' + svc.engine + ') · port ' + svc.port +
        ' · data: ' + (svc.dataKind === 'app-data' ? 'app storage' : svc.dataKind) +
        (svc.pbkdf2 ? ' · sign-in check ' + svc.pbkdf2.ms + ' ms' : '');
    } else if (serviceUp === false) {
      line = 'Photo website not running' + (serviceError ? ' (' + serviceError + ')' : '') + ' · retrying';
    } else {
      line = 'Checking the photo website…';
    }
    panelButtons.forEach(function (b, i) {
      var e = div('pbtn' + (b.small ? ' small' : '') + (b.cls ? ' ' + b.cls : '') + (i === panelFocus ? ' focused' : ''), b.label);
      b.el = e;
      if (b.small) diag.appendChild(e);
      else wrap.appendChild(e);
    });
    diag.appendChild(div('diag-text', line));
  }

  function renderPanelFocus() {
    panelButtons.forEach(function (b, i) { if (b.el) b.el.classList.toggle('focused', i === panelFocus); });
  }

  function openPanel() {
    mode = 'panel';
    confirmNewPw = 0;
    panelFocus = 0;
    renderPanel();
    scrim.classList.add('open');
    panel.classList.add('open');
    dock.classList.add('away');
    label.classList.remove('on');
    refresh().then(function () { if (mode === 'panel') renderPanel(); });
    P.storage().then(function (s) { storage = s; if (mode === 'panel') renderPanel(); });
  }

  function closePanel() {
    scrim.classList.remove('open');
    panel.classList.remove('open');
    dock.classList.remove('away');
    label.classList.add('on');
    mode = 'dock';
    confirmNewPw = 0;
  }

  function panelAction(b) {
    if (!b) return;
    if (b.id === 'close') { closePanel(); return; }
    if (b.id === 'unhide') {
      hidden = [];
      ls.set('gh.hidden', hidden);
      rebuildDock();
      panelFocus = 0;
      renderPanel();
      toast('All apps are back on the dock');
      return;
    }
    if (b.id === 'ytmode') {
      ytMode = YT_MODES[(YT_MODES.indexOf(ytMode) + 1) % YT_MODES.length];
      ls.set('gh.ytMode', ytMode);
      renderPanel();
      return;
    }
    if (b.id === 'newpw') {
      if (!confirmNewPw) {
        confirmNewPw = setTimeout(function () { confirmNewPw = 0; if (mode === 'panel') renderPanel(); }, 4000);
        renderPanel();
        return;
      }
      clearTimeout(confirmNewPw);
      confirmNewPw = 0;
      D.newPassword().then(function () {
        renderPanel();
        toast('New password made. Phones and computers need to sign in again.', 4500);
      }, function () {
        renderPanel();
        toast('Couldn’t change the password: the photo website isn’t running.', 4500);
      });
    }
  }

  // ---------- keys ----------
  function onKeyDown(e) {
    var k = e.keyCode;
    if (k === KEY.BACK || k === KEY.ESC || (k === KEY.BACKSPACE && cfg.preview)) {
      e.preventDefault();
      if (mode === 'menu') closeMenu();
      else if (mode === 'panel') closePanel();
      return;                                   // at the top level Back does nothing
    }
    if ([KEY.LEFT, KEY.RIGHT, KEY.UP, KEY.DOWN, KEY.ENTER].indexOf(k) < 0) return;
    e.preventDefault();
    if (mode === 'menu') {
      if (k === KEY.ENTER) {
        if (waitEnterRelease || e.repeat) return;   // OK still held from the long press
        var m = menuItems[menuFocus];
        closeMenu();
        if (m && !m.disabled) m.run();
        return;
      }
      if (k === KEY.UP || k === KEY.DOWN) {
        var d = k === KEY.UP ? -1 : 1;
        var j = menuFocus + d;
        while (j >= 0 && j < menuItems.length && menuItems[j].disabled) j += d;
        if (j >= 0 && j < menuItems.length) { menuFocus = j; renderMenuFocus(); }
      }
      return;
    }
    if (mode === 'panel') {
      if (k === KEY.ENTER) { if (!e.repeat) panelAction(panelButtons[panelFocus]); return; }
      // Buttons sit in one row; the small YouTube switch is alone below it.
      var small = panelButtons.length - 1;
      if (panelFocus === small) {
        if (k === KEY.UP) panelFocus = panelRowFocus;
      } else if (k === KEY.DOWN) {
        panelRowFocus = panelFocus;
        panelFocus = small;
      } else if (k === KEY.LEFT) {
        panelFocus = Math.max(0, panelFocus - 1);
      } else if (k === KEY.RIGHT) {
        panelFocus = Math.min(small - 1, panelFocus + 1);
      }
      renderPanelFocus();
      return;
    }
    if (k === KEY.LEFT) setFocus(focus - 1);
    else if (k === KEY.RIGHT) setFocus(focus + 1);
    else if (k === KEY.ENTER) {
      if (enterDown) return;                    // auto-repeat while held
      enterDown = true;
      longFired = false;
      clearTimeout(longTimer);
      longTimer = setTimeout(function () {
        longTimer = null;
        if (!enterDown || mode !== 'dock') return;
        longFired = true;
        waitEnterRelease = true;
        openMenu();
        // Normally the key-up clears this; the timer only covers a lost key-up.
        clearTimeout(releaseTimer);
        releaseTimer = setTimeout(function () { waitEnterRelease = false; }, 2500);
      }, cfg.longPressMs);
    }
  }

  function onKeyUp(e) {
    if (e.keyCode !== KEY.ENTER) return;
    waitEnterRelease = false;
    clearTimeout(releaseTimer);
    if (!enterDown) return;
    enterDown = false;
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = null;
      if (!longFired && mode === 'dock') activate(items[focus]);
    }
    longFired = false;
  }

  // ---------- photos ----------
  function shortLicence(l) {
    var s = String(l || '');
    if (/^CC0/i.test(s) || /public domain dedication/i.test(s)) return 'CC0';
    var m = /(CC BY(?:-[A-Z]{2})*\s*\d\.\d)/i.exec(s);
    if (m) return m[1].toUpperCase();
    if (/public domain/i.test(s)) return 'Public domain';
    return s;
  }

  function loadManifest() {
    function parse(r, base) {
      var list = r.data;
      if (list && !Array.isArray(list)) list = list.photos || list.items || list.wallpapers || null;
      if (!Array.isArray(list)) return null;
      return list.map(function (w) {
        var file = w.file || w.src || w.path;
        if (!file) return null;
        return {
          key: 'w:' + file,
          url: base + file,
          credit: [w.title, w.author, w.licence_short || shortLicence(w.licence || w.license)].filter(Boolean).join(' · '),
          user: false
        };
      }).filter(Boolean);
    }
    return GH.request('GET', 'wallpapers/manifest.json', undefined, 4000).then(function (r) {
      var list = parse(r, 'wallpapers/');
      if (list && list.length) return list;
      return GH.request('GET', '/preview-assets/manifest.json', undefined, 3000).then(function (r2) {
        return parse(r2, '/preview-assets/') || [];
      });
    }).then(function (list) { bundled = list; });
  }

  // Photos uploaded since the TV last looked are shown next ("fresh"); the
  // first sync after install only records what exists.
  function updatePhotos() {
    var st = photoService ? D.cached() : null;
    var list = st && st.photos ? st.photos : [];
    var known = ls.get('gh.bg.known');
    var knownSet = {};
    (known || []).forEach(function (id) { knownSet[id] = true; });
    var user = list.map(function (p) {
      return { key: 'u:' + p.id, url: D.media(p.url), credit: '', user: true, fresh: !!known && !knownSet[p.id] };
    });
    if (st && st.photos) ls.set('gh.bg.known', list.map(function (p) { return p.id; }));
    backdrop.setPhotos(bundled.concat(user));
  }

  var creditTimer = null;
  function showCredit(it) {
    var c = $('credit');
    c.classList.remove('on');
    clearTimeout(creditTimer);
    creditTimer = setTimeout(function () {
      c.textContent = it.credit || '';
      if (it.credit) c.classList.add('on');
    }, 500);
  }

  // ---------- service ----------
  function refresh() {
    if (!photoService) return Promise.resolve({ online: false });
    return D.refresh().then(function (r) {
      serviceUp = r.online;
      if (r.changed) {
        shortcuts = (r.state && r.state.shortcuts) || [];
        rebuildDock();
        if (backdrop) updatePhotos();
      }
      if (mode === 'panel') renderPanel();
      return r;
    });
  }

  function waitHealthy(tries) {
    return D.health(2000).then(function (ok) {
      if (ok || tries <= 1) return ok;
      return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(function () { return waitHealthy(tries - 1); });
    });
  }

  // Makes sure the photo service runs (it does not survive a reboot under a
  // public certificate, and the platform may reclaim it), then syncs.
  function ensureService() {
    if (ensuring || !photoService) return;
    ensuring = true;
    clearTimeout(retryTimer);
    D.health(2000).then(function (ok) {
      if (ok || !P.isTV) return ok;
      return P.startService().then(function () { serviceError = null; }, function (e) {
        serviceError = (e && (e.message || e.name)) || 'launch failed';
      }).then(function () { return waitHealthy(40); });
    }).then(function (ok) {
      ensuring = false;
      serviceUp = !!ok;
      if (ok) return refresh();
      if (mode === 'panel') renderPanel();
      if (!document.hidden) retryTimer = setTimeout(ensureService, 30000);
    });
  }

  function resolveApps() {
    return P.resolveApps(defs).then(function (found) {
      apps = found;
      if (found.youtube) P.setYouTubeId(found.youtube.id);
      ls.set('gh.apps.v1', { at: Date.now(), apps: found });
      rebuildDock();
    });
  }

  // ---------- multitasking ----------
  function onVisibility() {
    if (document.hidden) {
      document.documentElement.classList.add('paused');
      clearInterval(clockTimer);
      clearInterval(pollTimer);
      clearTimeout(retryTimer);
      clearTimeout(longTimer);
      enterDown = false;
      $('toast').classList.remove('on');
      if (backdrop) backdrop.pause();
      return;
    }
    document.documentElement.classList.remove('paused');
    setLaunching(false);
    renderClock();
    clearInterval(clockTimer);
    clearInterval(pollTimer);
    clockTimer = setInterval(renderClock, cfg.clockEveryMs);
    pollTimer = setInterval(refresh, cfg.pollEveryMs);
    if (backdrop) backdrop.resume();
    ensureService();
    resolveApps();
  }

  // ---------- performance guard ----------
  // If the TV cannot keep the slow drift smooth, keep the photos still.
  function frameProbe() {
    if (!window.requestAnimationFrame || Q.still === '1' || cfg.preview) return;
    var times = [];
    var last = 0;
    var end = Date.now() + 3000;
    function tick(t) {
      if (last) times.push(t - last);
      last = t;
      if (Date.now() < end && !document.hidden) { requestAnimationFrame(tick); return; }
      if (times.length < 20) return;
      times.sort(function (a, b) { return a - b; });
      var median = times[Math.floor(times.length / 2)];
      if (median > 26) {
        document.documentElement.classList.add('lite');
        if (backdrop) backdrop.opts.still = true;
      }
    }
    setTimeout(function () { requestAnimationFrame(tick); }, 4000);
  }

  // ---------- start ----------
  function loadMock() {
    if (!cfg.preview) return Promise.resolve();
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/dev/mock.js';
      s.onload = resolve;
      s.onerror = resolve;
      document.head.appendChild(s);
      setTimeout(resolve, 2000);
    });
  }

  function init() {
    if (Q.still === '1') document.documentElement.classList.add('still');
    fitStage();
    window.addEventListener('resize', fitStage);
    renderClock();
    clockTimer = setInterval(renderClock, cfg.clockEveryMs);

    var cachedApps = ls.get('gh.apps.v1');
    if (cachedApps && cachedApps.apps) apps = cachedApps.apps;
    var st = photoService ? D.cached() : null;
    shortcuts = (st && st.shortcuts) || [];
    focusKey = ls.get('gh.focus');
    rebuildDock();

    backdrop = new GH.Backdrop($('bg-a'), $('bg-b'), {
      interval: cfg.photoIntervalMs, fade: cfg.fadeMs, scale: cfg.kenBurnsScale,
      still: Q.still === '1', onShow: showCredit
    });
    loadManifest().then(function () {
      updatePhotos();
      var first = Q.bg ? (/^\d+$/.test(Q.bg) && bundled[+Q.bg] ? bundled[+Q.bg].key : 'w:' + Q.bg) : null;
      backdrop.start(first);
    });

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('visibilitychange', onVisibility);

    loadMock().then(resolveApps).then(function () {
      if (Q.focus && /^\d+$/.test(Q.focus)) setFocus(+Q.focus);
      ensureService();
      if (Q.panel === '1' && photoService) setTimeout(openPanel, 300);
      if (Q.menu === '1') setTimeout(openMenu, 300);
    });
    pollTimer = setInterval(refresh, cfg.pollEveryMs);
    frameProbe();
  }

  init();
}());
