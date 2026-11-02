// Glass Home service - the LAN website and the TV app's local channel.
//
// Runs in two places with the same code:
//   - on the TV as a Tizen web service (service/index.js), Node 12 API
//   - on a Mac with Node 22 for testing (dev/run.js)
// So: Node 12 API only. No ?. or ??, no fs/promises, no global fetch,
// no 'node:' imports, no object spread, no optional catch binding.
//
// Three kinds of caller:
//   website  - a phone or computer on the home LAN, signed in with the password
//              (session cookie: HttpOnly, SameSite=Strict, 30 days)
//   TV app   - Glass Home itself: loopback address AND the package's local key
//              (js/local-key.js, which is inside the app and never served)
//   anyone   - only GET /health and the sign-in page
// Clients outside loopback and the private LAN ranges are dropped.
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var urlmod = require('url');
var crypto = require('crypto');
var netu = require('./netutil.js');
var imgu = require('./imageutil.js');
var auth = require('./auth.js');
var storeMod = require('./store.js');
var yt = require('../js/ytparse.js');
var vetro = require('./vetro.js');

var VERSION = '1.0.0';
var COOKIE = 'gh_sid';
var DAY = 24 * 3600 * 1000;

var DEFAULTS = {
  port: 8090,
  packageId: 'GlassHome1',
  dataDir: null,
  pbkdf2Iterations: 300000,
  maxPhotos: 300,
  maxPhotoBytes: 15 * 1024 * 1024,
  maxThumbBytes: 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxShortcuts: 60,
  sessionDays: 30,
  maxSessions: 30,
  lockoutFailures: 5,
  lockoutMinutes: 5,
  fetchIcons: true
};

function readJSONFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function readLocalKey(appDir) {
  try {
    var src = fs.readFileSync(path.join(appDir, 'js', 'local-key.js'), 'utf8');
    var m = /GH_LOCAL_KEY\s*=\s*['"]([A-Za-z0-9_-]{20,})['"]/.exec(src);
    if (m) return m[1];
  } catch (e) { /* missing */ }
  return null;
}

function splitPath(p) {
  if (typeof p !== 'string' || p.charAt(0) !== '/' || p.length > 1024) return null;
  var raw = p.split('/').slice(1);
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var s;
    try { s = decodeURIComponent(raw[i]); } catch (e) { return null; }
    if (s === '.' || s === '..' || /[\/\\\u0000]/.test(s)) return null;
    out.push(s);
  }
  if (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

function getCookie(req, name) {
  var parts = String(req.headers.cookie || '').split(';');
  for (var i = 0; i < parts.length; i++) {
    var j = parts[i].indexOf('=');
    if (j < 0) continue;
    if (parts[i].slice(0, j).trim() === name) return parts[i].slice(j + 1).trim();
  }
  return null;
}

function engineName() {
  var v = process.versions || {};
  if (v.escargot) return 'Escargot ' + v.escargot;
  if (v.lwnode) return 'lwnode ' + v.lwnode;
  if (v.v8) return 'V8 ' + v.v8;
  return 'unknown';
}

function cleanName(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 40);
}

function normalizeWebUrl(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/\//, '');
  var u;
  try { u = new urlmod.URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  if (!/^[a-z0-9.[\]:-]+$/i.test(u.hostname)) return null;
  return u.href;
}

function hostLabel(href) {
  try { return new urlmod.URL(href).hostname.replace(/^www\./, ''); } catch (e) { return 'Website'; }
}

function createService(opts) {
  opts = opts || {};
  var appDir = opts.appDir || path.join(__dirname, '..');
  var serviceDir = path.join(appDir, 'service');
  var log = opts.log || function () { console.log.apply(console, arguments); };
  var cfg = {};
  var fileCfg = readJSONFile(path.join(serviceDir, 'config.json')) || {};
  Object.keys(DEFAULTS).forEach(function (k) { cfg[k] = DEFAULTS[k]; });
  Object.keys(fileCfg).forEach(function (k) { if (k in DEFAULTS) cfg[k] = fileCfg[k]; });
  Object.keys(opts.config || {}).forEach(function (k) { cfg[k] = opts.config[k]; });
  if (opts.port) cfg.port = opts.port;
  var readVetroApps = vetro.createReader(cfg.packageId);

  var hosts = opts.hosts || ['0.0.0.0'];
  var localKey = readLocalKey(appDir);
  var limiter = new auth.Limiter({ failures: cfg.lockoutFailures, lockMs: cfg.lockoutMinutes * 60 * 1000 });
  var store = null;
  var dataInfo = null;
  var servers = [];
  var plain = null;                  // { id, value }: current password; also in shown.json for restarts
  var errors = [];
  var startedAt = Date.now();
  var uploadsInFlight = 0;
  var jobs = [];
  var jobRunning = false;
  var fetcher = null;
  var fetcherError = null;
  var sweepTimer = null;
  var webTemplate = null;
  var listening = [];
  // New hashes use this many PBKDF2 iterations (never fewer than 200,000). If
  // the TV's runtime needs more than 1.5 s for 300,000, it drops to 200,000.
  var iterations = Math.max(200000, Number(cfg.pbkdf2Iterations) || 300000);
  var pbkdf2Stats = null;

  if (!localKey) {
    localKey = auth.randomToken(32);
    note('js/local-key.js missing: the TV app cannot use the local channel');
  }

  function note(msg) {
    var line = new Date().toISOString() + ' ' + msg;
    errors.push(line);
    if (errors.length > 20) errors.shift();
    log(msg);
  }

  function getFetcher() {
    if (fetcher || fetcherError) return fetcher;
    try { fetcher = require('./fetcher.js'); } catch (e) { fetcherError = e; note('fetcher unavailable: ' + e.message); }
    return fetcher;
  }

  function loadTemplate() {
    try {
      var html = fs.readFileSync(path.join(serviceDir, 'web', 'index.html'), 'utf8');
      var parser = fs.readFileSync(path.join(appDir, 'js', 'ytparse.js'), 'utf8');
      webTemplate = html.split('/*@@YTPARSE@@*/').join(parser.replace(/<\/script/gi, '<\\/script'));
    } catch (e) {
      webTemplate = null;
      note('website template missing: ' + e.message);
    }
  }

  // ---------- responses ----------
  function baseHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  function sendJSON(res, status, obj, headers) {
    if (res.headersSent) return;
    var body = JSON.stringify(obj == null ? {} : obj);
    var h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) };
    Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
    res.writeHead(status, h);
    res.end(body);
  }

  function sendEmpty(res, status, headers) {
    if (res.headersSent) return;
    var h = { 'Cache-Control': 'no-store', 'Content-Length': 0 };
    Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
    res.writeHead(status, h);
    res.end();
  }

  function corsOpen(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-GH-Key, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  function serveFile(res, file, type, cacheSeconds, extra) {
    fs.stat(file, function (err, st) {
      if (err || !st.isFile()) return sendJSON(res, 404, { error: 'not-found' });
      var h = {
        'Content-Type': type,
        'Content-Length': st.size,
        'Cache-Control': cacheSeconds ? 'private, max-age=' + cacheSeconds + (cacheSeconds > 86400 ? ', immutable' : '') : 'no-store'
      };
      Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
      res.writeHead(200, h);
      var rs = fs.createReadStream(file);
      rs.on('error', function () { res.destroy(); });
      rs.pipe(res);
    });
  }

  // Ignores the rest of a request body we refuse, without reading forever.
  function refuseBody(req, res, status, obj) {
    sendJSON(res, status, obj, { 'Connection': 'close' });
    req.resume();
    var t = setTimeout(function () { try { req.socket.destroy(); } catch (e) { /* ignore */ } }, 5000);
    req.on('end', function () { clearTimeout(t); });
  }

  function readJSONBody(req, limit) {
    return new Promise(function (resolve, reject) {
      var ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return reject({ status: 415, error: 'json-required' });
      var chunks = [];
      var size = 0;
      var failed = false;
      req.on('data', function (c) {
        if (failed) return;
        size += c.length;
        if (size > (limit || 65536)) { failed = true; reject({ status: 413, error: 'too-large' }); return; }
        chunks.push(c);
      });
      req.on('end', function () {
        if (failed) return;
        try {
          var v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object expected');
          resolve(v);
        } catch (e) { reject({ status: 400, error: 'bad-json' }); }
      });
      req.on('error', function () { if (!failed) { failed = true; reject({ status: 400, error: 'read' }); } });
    });
  }

  function bodyError(res, e) {
    if (e && e.status) return sendJSON(res, e.status, { error: e.error || 'error' }, e.status === 413 ? { 'Connection': 'close' } : null);
    note('request failed: ' + (e && e.stack ? e.stack : e));
    sendJSON(res, 500, { error: 'server' });
  }

  // ---------- who is calling ----------
  function isLocal(ctx) {
    if (!ctx.loopback) return false;
    var k = ctx.req.headers['x-gh-key'] || (ctx.query && ctx.query.k);
    if (Array.isArray(k)) k = k[0];
    return !!k && auth.timingSafeEqualStr(String(k), localKey);
  }

  // CSRF guard for the website API: a custom header (which a cross-site page
  // cannot send without a CORS preflight this server never approves), plus the
  // Origin and Fetch Metadata headers when the browser sends them.
  function sameOriginRequest(ctx) {
    var h = ctx.req.headers;
    if (h['x-gh'] !== '1') return false;
    var origin = h.origin;
    if (origin !== undefined) {
      if (String(origin).toLowerCase() !== 'http://' + String(h.host || '').toLowerCase()) return false;
    }
    var site = h['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
    return true;
  }

  function sessionFor(ctx) {
    var tok = getCookie(ctx.req, COOKIE);
    if (!tok || tok.length > 128 || !store.state.password) return null;
    var h = auth.sha256hex(tok);
    var now = Date.now();
    var list = store.state.sessions;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.h !== h) continue;
      if (s.expires <= now || s.pw !== store.state.password.id) return null;
      if (now - (s.renewed || s.created) > DAY) {          // sliding 30 days, renewed daily
        s.renewed = now;
        s.expires = now + cfg.sessionDays * DAY;
        store.save();
        ctx.res.setHeader('Set-Cookie', cookieValue(tok, cfg.sessionDays * 86400));
      }
      return s;
    }
    return null;
  }

  function cookieValue(tok, maxAge) {
    return COOKIE + '=' + tok + '; Max-Age=' + maxAge + '; Path=/; HttpOnly; SameSite=Strict';
  }

  function createSession(res) {
    var tok = auth.randomToken(32);
    var now = Date.now();
    store.state.sessions.push({ h: auth.sha256hex(tok), created: now, renewed: now, expires: now + cfg.sessionDays * DAY, pw: store.state.password.id });
    store.state.sessions.sort(function (a, b) { return b.renewed - a.renewed; });
    store.state.sessions = store.state.sessions.slice(0, cfg.maxSessions);
    store.save();
    if (res) res.setHeader('Set-Cookie', cookieValue(tok, cfg.sessionDays * 86400));
    return tok;
  }

  // ---------- password ----------
  function timed(iter, started) {
    var ms = Date.now() - started;
    pbkdf2Stats = { iterations: iter, ms: ms };
    if (ms > 1500 && iterations > 200000) {
      iterations = 200000;
      note('PBKDF2 is slow here (' + ms + ' ms for ' + iter + ' iterations); new hashes use 200000');
    }
  }

  function setPassword(value, generated) {
    var started = Date.now();
    return auth.hashPassword(value, iterations, generated).then(function (rec) {
      timed(rec.iter, started);
      store.state.password = rec;
      store.state.sessions = [];                 // every existing sign-in ends
      plain = { id: rec.id, value: generated ? auth.canonicalGenerated(value) : value };
      store.writeShown(plain);                    // so the TV can show it after a restart
      store.bump();
      return rec;
    });
  }

  // Wrong passwords are throttled per address and globally, and each address
  // gets a fair share of the check queue (see auth.Limiter). A refused attempt
  // rejects with code BUSY, which the routes answer with 503.
  function checkPassword(ctx, attempt) {
    var started = Date.now();
    var st = limiter.status(ctx.ip);
    if (st.locked) return Promise.resolve({ ok: false, locked: true, retryAfter: st.retryAfter });
    return limiter.serial(ctx.ip, function () {
      var again = limiter.status(ctx.ip);
      if (again.locked) return { ok: false, locked: true, retryAfter: again.retryAfter };
      var t0 = 0;
      return auth.delay(limiter.globalDelay()).then(function () {
        t0 = Date.now();
        return auth.verifyPassword(attempt, store.state.password);
      }).then(function (ok) {
        if (store.state.password) timed(store.state.password.iter, t0);
        if (ok) { limiter.success(ctx.ip); return { ok: true }; }
        var r = limiter.fail(ctx.ip);
        return auth.delay(600 - (Date.now() - started)).then(function () {
          return { ok: false, locked: r.locked, retryAfter: r.retryAfter, remaining: r.remaining };
        });
      });
    });
  }

  function sendAuthFailure(res, r) {
    if (r.locked) return sendJSON(res, 429, { error: 'locked', retryAfter: r.retryAfter }, { 'Retry-After': String(r.retryAfter) });
    sendJSON(res, 401, { error: 'wrong-password', remaining: r.remaining });
  }

  // ---------- views ----------
  function photoView(p) {
    return { id: p.id, added: p.added, bytes: p.bytes, w: p.w, h: p.h, thumb: !!p.thumb };
  }

  function shortcutView(x) {
    return {
      id: x.id, type: x.type, name: x.name, url: x.url,
      videoId: x.videoId || null, playlistId: x.playlistId || null, start: x.start || 0,
      icon: x.icon ? '/media/icons/' + x.icon : null, iconW: x.iconW || 0, iconH: x.iconH || 0,
      iconState: x.iconState || 'none', added: x.added
    };
  }

  function limitsView() {
    return {
      photos: store.state.photos.length, maxPhotos: cfg.maxPhotos,
      bytes: store.totalBytes(), maxBytes: cfg.maxTotalBytes,
      shortcuts: store.state.shortcuts.length, maxShortcuts: cfg.maxShortcuts
    };
  }

  function lanInfo() {
    if (opts.advertiseUrl) return { ip: null, port: cfg.port, url: opts.advertiseUrl };
    var addrs = netu.lanAddresses();
    var ip = addrs.length ? addrs[0].address : null;
    return { ip: ip, port: cfg.port, url: ip ? 'http://' + ip + ':' + cfg.port : null, all: addrs.map(function (a) { return a.name + ' ' + a.address; }) };
  }

  function serviceInfo() {
    return {
      version: VERSION,
      node: process.version,
      engine: engineName(),
      versions: process.versions,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      dataDir: dataInfo ? dataInfo.dir : null,
      dataKind: dataInfo ? dataInfo.kind : null,
      port: cfg.port,
      listening: listening.slice(),
      fetcher: fetcherError ? 'unavailable' : 'ok',
      pbkdf2: pbkdf2Stats,
      errors: errors.slice(-5)
    };
  }

  // ---------- shortcut enrichment (icons, titles, thumbnails) ----------
  function saveIcon(sc, bytes, ext, w, h) {
    var file = sc.id + '-' + auth.randomHex(4) + '.' + ext;
    fs.writeFileSync(store.iconPath(file), bytes);
    if (sc.icon) storeMod.unlinkQuiet(store.iconPath(sc.icon));
    sc.icon = file;
    sc.iconW = w || 0;
    sc.iconH = h || 0;
  }

  function enqueue(id) {
    if (jobs.indexOf(id) < 0) jobs.push(id);
    pump();
  }

  function pump() {
    if (jobRunning || !jobs.length) return;
    jobRunning = true;
    var id = jobs.shift();
    var finished = function () { jobRunning = false; setTimeout(pump, 50); };
    enrich(id).then(finished, function (e) { note('enrich failed: ' + (e && e.message)); finished(); });
  }

  function ytCacheFile(p) {
    return 'yt-' + auth.sha256hex((p.videoId || '') + '|' + (p.playlistId || '')).slice(0, 16) + '.jpg';
  }

  function enrich(id) {
    var sc = store.findShortcut(id);
    if (!sc) return Promise.resolve();
    var f = cfg.fetchIcons ? getFetcher() : null;
    if (!f) {
      sc.iconState = 'none';
      store.bump();
      return Promise.resolve();
    }
    if (sc.type === 'youtube') {
      var p = { videoId: sc.videoId, playlistId: sc.playlistId, start: sc.start };
      var cached = path.join(store.cacheDir, ytCacheFile(p));
      var info = null;
      return f.youtubeInfo(p).then(function (i) {
        info = i;
        if (fs.existsSync(cached)) {
          var bytes = fs.readFileSync(cached);
          var s = imgu.jpegSize(bytes);
          return s ? { bytes: bytes, width: s.width, height: s.height } : null;
        }
        return f.youtubeThumb(p, info);
      }).then(function (thumb) {
        var cur = store.findShortcut(id);
        if (!cur) return;
        if (thumb) saveIcon(cur, thumb.bytes, 'jpg', thumb.width, thumb.height);
        if (info && info.title && cur.autoName) { cur.name = cleanName(info.title, 80); cur.autoName = false; }
        cur.iconState = thumb ? 'ok' : 'none';
        store.bump();
      });
    }
    return f.findSiteIcon(sc.url).then(function (r) {
      var cur = store.findShortcut(id);
      if (!cur) return;
      if (r.icon) saveIcon(cur, r.icon.bytes, r.icon.ext, r.icon.width, r.icon.height);
      cur.iconState = r.icon ? 'ok' : 'none';
      store.bump();
    });
  }

  function addShortcut(body) {
    if (store.state.shortcuts.length >= cfg.maxShortcuts) return { status: 507, error: 'too-many-shortcuts' };
    var type = body.type === 'youtube' ? 'youtube' : 'web';
    var name = cleanName(body.name, 80);
    var p = null;
    var url;
    if (type === 'web') {
      url = normalizeWebUrl(body.url);
      if (!url) return { status: 400, error: 'bad-url' };
      p = yt.parse(url);                         // a YouTube video link becomes a video tile
      if (p) type = 'youtube';
    } else {
      p = yt.parse(body.url);
      if (!p) return { status: 400, error: 'not-youtube' };
    }
    var sc = { id: auth.randomHex(8), type: type, added: Date.now(), icon: null, iconState: 'pending' };
    if (type === 'youtube') {
      sc.videoId = p.videoId;
      sc.playlistId = p.playlistId;
      sc.start = p.start || 0;
      sc.url = yt.canonicalUrl(p);
      sc.name = name || (p.videoId ? 'YouTube video' : 'YouTube playlist');
      sc.autoName = !name;
    } else {
      sc.url = url;
      sc.name = name || hostLabel(url);
    }
    store.state.shortcuts.push(sc);
    store.bump();
    enqueue(sc.id);
    return { status: 201, shortcut: sc };
  }

  // ---------- uploads ----------
  // Streams a JPEG body to a temporary file, checks it, then renames it to
  // destFile and calls done(bytes, size). If given, check(bytes, size) runs
  // synchronously just before the rename; returning { status, body } refuses
  // the upload: the temporary file is deleted and any existing destFile is
  // left untouched.
  function receiveJpeg(ctx, maxBytes, destFile, done, check) {
    var req = ctx.req;
    var res = ctx.res;
    var HEAD_MAX = 512 * 1024;
    var cl = parseInt(req.headers['content-length'], 10);
    var ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'image/jpeg' && ct !== 'image/jpg') return refuseBody(req, res, 415, { error: 'jpeg-only' });
    if (!isNaN(cl) && cl > maxBytes) return refuseBody(req, res, 413, { error: 'too-large', max: maxBytes });
    var tmp = path.join(path.dirname(destFile), '.up-' + auth.randomHex(6));
    var out = fs.createWriteStream(tmp, { flags: 'wx', mode: 384 });
    var got = 0;
    var head = [];
    var headLen = 0;
    var failed = false;
    uploadsInFlight += 1;
    function release() { if (uploadsInFlight > 0) uploadsInFlight -= 1; }
    function fail(status, obj) {
      if (failed) return;
      failed = true;
      release();
      out.destroy();
      storeMod.unlinkQuiet(tmp);
      if (status) refuseBody(req, res, status, obj);
    }
    out.on('error', function (e) { note('upload write failed: ' + e.message); fail(507, { error: 'disk' }); });
    req.on('data', function (chunk) {
      if (failed) return;
      got += chunk.length;
      if (got > maxBytes) return fail(413, { error: 'too-large', max: maxBytes });
      if (headLen < HEAD_MAX) {
        var take = chunk.slice(0, HEAD_MAX - headLen);
        head.push(take);
        headLen += take.length;
        if (headLen >= 3 && !imgu.isJpegStart(Buffer.concat(head, Math.min(headLen, 16)))) return fail(415, { error: 'not-jpeg' });
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', function () { req.resume(); });
      }
    });
    req.on('aborted', function () { fail(0); });
    req.on('close', function () { if (!req.complete) fail(0); });
    req.on('end', function () {
      if (failed) return;
      out.end(function () {
        if (failed) return;
        var size = imgu.jpegSize(Buffer.concat(head, headLen));
        if (!size || got < 125) return fail(415, { error: 'not-jpeg' });
        if (size.width > 16000 || size.height > 16000) return fail(415, { error: 'too-big-dimensions' });
        var refused = check ? check(got, size) : null;
        if (refused) return fail(refused.status, refused.body);
        fs.rename(tmp, destFile, function (err) {
          release();
          if (err) { storeMod.unlinkQuiet(tmp); note('rename failed: ' + err.message); return sendJSON(res, 500, { error: 'disk' }); }
          done(got, size);
        });
      });
    });
  }

  function handlePhotoUpload(ctx) {
    var req = ctx.req;
    var cl = parseInt(req.headers['content-length'], 10);
    if (store.state.photos.length >= cfg.maxPhotos) return refuseBody(req, ctx.res, 507, { error: 'full', reason: 'count', max: cfg.maxPhotos });
    if (store.totalBytes() + (isNaN(cl) ? 0 : cl) > cfg.maxTotalBytes) return refuseBody(req, ctx.res, 507, { error: 'full', reason: 'bytes', max: cfg.maxTotalBytes });
    if (uploadsInFlight >= 3) return refuseBody(req, ctx.res, 429, { error: 'busy' });
    var id = auth.randomHex(12);
    receiveJpeg(ctx, cfg.maxPhotoBytes, store.photoPath(id), function (bytes, size) {
      if (store.state.photos.length >= cfg.maxPhotos || store.totalBytes() + bytes > cfg.maxTotalBytes) {
        storeMod.unlinkQuiet(store.photoPath(id));
        return sendJSON(ctx.res, 507, { error: 'full' });
      }
      var rec = { id: id, added: Date.now(), bytes: bytes, w: size.width, h: size.height, thumb: false };
      store.state.photos.push(rec);
      store.bump();
      sendJSON(ctx.res, 201, { photo: photoView(rec), limits: limitsView() });
    });
  }

  // Thumbnails count towards the storage cap like photos (store.totalBytes()
  // adds them up). A new thumbnail replaces the photo's old one, so the old
  // one's bytes are not counted twice. Checked before receiving (declared
  // length) and again with the real size before the file is kept.
  function handleThumbUpload(ctx, id) {
    var req = ctx.req;
    var full = { error: 'full', reason: 'bytes', max: cfg.maxTotalBytes };
    var p = store.findPhoto(id);
    if (!p) return refuseBody(req, ctx.res, 404, { error: 'not-found' });
    var cl = parseInt(req.headers['content-length'], 10);
    if (store.totalBytes() - (p.thumbBytes || 0) + (isNaN(cl) ? 0 : cl) > cfg.maxTotalBytes) return refuseBody(req, ctx.res, 507, full);
    receiveJpeg(ctx, cfg.maxThumbBytes, store.thumbPath(id), function (bytes) {
      var cur = store.findPhoto(id);
      if (!cur) { storeMod.unlinkQuiet(store.thumbPath(id)); return sendJSON(ctx.res, 404, { error: 'not-found' }); }
      cur.thumb = true;
      cur.thumbBytes = bytes;
      store.save();
      sendEmpty(ctx.res, 204);
    }, function (bytes) {
      var cur = store.findPhoto(id);
      if (!cur) return { status: 404, body: { error: 'not-found' } };
      if (store.totalBytes() - (cur.thumbBytes || 0) + bytes > cfg.maxTotalBytes) return { status: 507, body: full };
      // Counted from now on: the rename is asynchronous, and another upload
      // finishing before it completes must see these bytes in its own check.
      cur.thumbBytes = bytes;
      return null;
    });
  }

  // ---------- routes ----------
  function routeWebsite(ctx) {
    if (!webTemplate) loadTemplate();
    if (!webTemplate) return sendJSON(ctx.res, 500, { error: 'website-missing' });
    var nonce = auth.randomToken(16);
    var html = webTemplate.split('{{NONCE}}').join(nonce);
    ctx.res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' blob: data:; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    });
    ctx.res.end(html);
  }

  function wallpaperOfTheDay() {
    var dir = path.join(appDir, 'wallpapers');
    var files;
    try { files = fs.readdirSync(dir).filter(function (f) { return /^[A-Za-z0-9._-]+\.jpe?g$/i.test(f); }).sort(); } catch (e) { files = []; }
    if (!files.length) return null;
    var day = Math.floor(Date.now() / DAY);
    return path.join(dir, files[day % files.length]);
  }

  function handleApi(ctx) {
    var req = ctx.req;
    var res = ctx.res;
    var m = ctx.method;
    var s = ctx.segs;
    if (!sameOriginRequest(ctx)) return refuseBody(req, res, 403, { error: 'csrf' });

    if (s[1] === 'login' && s.length === 2 && m === 'POST') {
      return readJSONBody(req, 4096).then(function (body) {
        return checkPassword(ctx, String(body.password == null ? '' : body.password)).then(function (r) {
          if (!r.ok) return sendAuthFailure(res, r);
          createSession(res);
          sendJSON(res, 200, { ok: true });
        });
      }).catch(function (e) {
        if (e && e.code === 'BUSY') return sendJSON(res, 503, { error: 'busy' }, { 'Retry-After': '5' });
        bodyError(res, e);
      });
    }

    var session = sessionFor(ctx);
    if (!session) return refuseBody(req, res, 401, { error: 'signin' });

    if (s[1] === 'logout' && s.length === 2 && m === 'POST') {
      store.state.sessions = store.state.sessions.filter(function (x) { return x.h !== session.h; });
      store.save();
      return sendEmpty(res, 204, { 'Set-Cookie': cookieValue('', 0) });
    }

    if (s[1] === 'me' && s.length === 2 && m === 'GET') {
      return sendJSON(res, 200, { ok: true, limits: limitsView(), tv: lanInfo(), version: VERSION });
    }

    if (s[1] === 'password' && s.length === 2 && m === 'POST') {
      return readJSONBody(req, 4096).then(function (body) {
        var next = String(body.next == null ? '' : body.next);
        if (next.length < 6 || next.length > 128 || /^\s|\s$/.test(next)) return sendJSON(res, 400, { error: 'weak-password' });
        return checkPassword(ctx, String(body.current == null ? '' : body.current)).then(function (r) {
          if (!r.ok) return sendAuthFailure(res, r);
          return setPassword(next, false).then(function () {
            createSession(res);
            sendJSON(res, 200, { ok: true });
          });
        });
      }).catch(function (e) {
        if (e && e.code === 'BUSY') return sendJSON(res, 503, { error: 'busy' }, { 'Retry-After': '5' });
        bodyError(res, e);
      });
    }

    if (s[1] === 'photos') {
      if (s.length === 2 && m === 'GET') {
        var list = store.state.photos.slice().reverse().map(photoView);
        return sendJSON(res, 200, { photos: list, limits: limitsView() });
      }
      if (s.length === 2 && m === 'POST') return handlePhotoUpload(ctx);
      if (s.length >= 3 && !storeMod.PHOTO_ID.test(s[2])) return refuseBody(req, res, 400, { error: 'bad-id' });
      if (s.length === 4 && s[3] === 'thumb' && m === 'PUT') return handleThumbUpload(ctx, s[2]);
      if (s.length === 3 && m === 'DELETE') {
        if (!store.removePhoto(s[2])) return sendJSON(res, 404, { error: 'not-found' });
        return sendJSON(res, 200, { ok: true, limits: limitsView() });
      }
    }

    if (s[1] === 'shortcuts') {
      if (s.length === 2 && m === 'GET') {
        return sendJSON(res, 200, { shortcuts: store.state.shortcuts.map(shortcutView), limits: limitsView() });
      }
      if (s.length === 2 && m === 'POST') {
        return readJSONBody(req, 8192).then(function (body) {
          var r = addShortcut(body);
          if (r.error) return sendJSON(res, r.status, { error: r.error });
          sendJSON(res, 201, { shortcut: shortcutView(r.shortcut) });
        }).catch(function (e) { bodyError(res, e); });
      }
      if (s.length === 3 && s[2] === 'order' && m === 'POST') {
        return readJSONBody(req, 16384).then(function (body) {
          if (!Array.isArray(body.ids)) return sendJSON(res, 400, { error: 'ids-required' });
          store.reorderShortcuts(body.ids.filter(function (x) { return typeof x === 'string' && storeMod.SHORTCUT_ID.test(x); }));
          sendJSON(res, 200, { shortcuts: store.state.shortcuts.map(shortcutView) });
        }).catch(function (e) { bodyError(res, e); });
      }
      if (s.length === 3 && !storeMod.SHORTCUT_ID.test(s[2])) return refuseBody(req, res, 400, { error: 'bad-id' });
      if (s.length === 3 && m === 'PATCH') {
        return readJSONBody(req, 4096).then(function (body) {
          var sc = store.findShortcut(s[2]);
          if (!sc) return sendJSON(res, 404, { error: 'not-found' });
          var name = cleanName(body.name, 80);
          if (!name) return sendJSON(res, 400, { error: 'name-required' });
          sc.name = name;
          sc.autoName = false;
          store.bump();
          sendJSON(res, 200, { shortcut: shortcutView(sc) });
        }).catch(function (e) { bodyError(res, e); });
      }
      if (s.length === 3 && m === 'DELETE') {
        if (!store.removeShortcut(s[2])) return sendJSON(res, 404, { error: 'not-found' });
        return sendJSON(res, 200, { ok: true });
      }
    }

    if (s[1] === 'youtube' && s[2] === 'preview' && s.length === 3 && m === 'GET') {
      var p = yt.parse(String(ctx.query.url || ''));
      if (!p) return sendJSON(res, 400, { error: 'not-youtube' });
      var out = { videoId: p.videoId, playlistId: p.playlistId, start: p.start, url: yt.canonicalUrl(p), title: null, author: null, thumb: null };
      var f = cfg.fetchIcons ? getFetcher() : null;
      if (!f) return sendJSON(res, 200, out);
      var file = ytCacheFile(p);
      var info = null;
      return f.youtubeInfo(p).then(function (i) {
        info = i;
        if (info) { out.title = info.title; out.author = info.author; }
        if (fs.existsSync(store.cachePath(file))) return true;
        return f.youtubeThumb(p, info).then(function (t) {
          if (!t) return false;
          trimCache();
          fs.writeFileSync(store.cachePath(file), t.bytes);
          return true;
        });
      }).then(function (have) {
        if (have) out.thumb = '/media/cache/' + file;
        sendJSON(res, 200, out);
      }).catch(function (e) { note('preview failed: ' + (e && e.message)); sendJSON(res, 200, out); });
    }

    return refuseBody(req, res, 404, { error: 'not-found' });
  }

  function trimCache() {
    var files;
    try { files = fs.readdirSync(store.cacheDir); } catch (e) { return; }
    if (files.length < 40) return;
    files.map(function (f) {
      var t = 0;
      try { t = fs.statSync(path.join(store.cacheDir, f)).mtime.getTime(); } catch (e) { /* ignore */ }
      return { f: f, t: t };
    }).sort(function (a, b) { return a.t - b.t; }).slice(0, files.length - 30).forEach(function (x) {
      storeMod.unlinkQuiet(path.join(store.cacheDir, x.f));
    });
  }

  function handleMedia(ctx) {
    var s = ctx.segs;
    corsOpen(ctx.res);
    if (ctx.method !== 'GET') return sendJSON(ctx.res, 405, { error: 'method' });
    if (!isLocal(ctx) && !sessionFor(ctx)) return sendJSON(ctx.res, 401, { error: 'signin' });
    if (s.length !== 3) return sendJSON(ctx.res, 404, { error: 'not-found' });
    var name = s[2];
    var year = 365 * 86400;
    var m;
    if (s[1] === 'photos' || s[1] === 'thumbs') {
      m = /^([a-f0-9]{24})\.jpg$/.exec(name);
      if (!m || !store.findPhoto(m[1])) return sendJSON(ctx.res, 404, { error: 'not-found' });
      return serveFile(ctx.res, s[1] === 'photos' ? store.photoPath(m[1]) : store.thumbPath(m[1]), 'image/jpeg', year);
    }
    if (s[1] === 'icons') {
      if (!storeMod.ICON_FILE.test(name)) return sendJSON(ctx.res, 404, { error: 'not-found' });
      var ext = name.split('.').pop();
      var types = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };
      var extra = ext === 'svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : null;
      return serveFile(ctx.res, store.iconPath(name), types[ext], year, extra);
    }
    if (s[1] === 'cache') {
      if (!storeMod.CACHE_FILE.test(name)) return sendJSON(ctx.res, 404, { error: 'not-found' });
      return serveFile(ctx.res, store.cachePath(name), 'image/jpeg', 3600);
    }
    sendJSON(ctx.res, 404, { error: 'not-found' });
  }

  function localState(sinceRev) {
    var pw = store.state.password;
    if (sinceRev && Number(sinceRev) === store.state.rev) return { rev: store.state.rev, same: true, service: serviceInfo(), lan: lanInfo() };
    return {
      rev: store.state.rev,
      service: serviceInfo(),
      lan: lanInfo(),
      password: pw ? { id: pw.id, generated: !!pw.generated, plain: plain && plain.id === pw.id ? plain.value : null } : null,
      photos: store.state.photos.map(function (p) { return { id: p.id, added: p.added, w: p.w, h: p.h, url: '/media/photos/' + p.id + '.jpg' }; }),
      shortcuts: store.state.shortcuts.map(shortcutView),
      limits: limitsView()
    };
  }

  function handleLocal(ctx) {
    var req = ctx.req;
    var res = ctx.res;
    var s = ctx.segs;
    var m = ctx.method;
    corsOpen(res);
    if (m === 'OPTIONS') return sendEmpty(res, 204);
    if (!isLocal(ctx)) return refuseBody(req, res, 403, { error: 'local-only' });
    if (s[1] === 'vetro' && s[2] === 'apps' && s.length === 3 && m === 'GET') {
      return readVetroApps().then(function (result) { sendJSON(res, 200, result); });
    }
    if (s[1] === 'state' && s.length === 2 && m === 'GET') return sendJSON(res, 200, localState(ctx.query.rev));
    if (s[1] === 'password' && s.length === 2 && m === 'POST') {
      req.resume();
      var value = auth.generatePassword();
      return setPassword(value, true).then(function (rec) {
        sendJSON(res, 200, { id: rec.id, plain: value });
      }).catch(function (e) { bodyError(res, e); });
    }
    if (s[1] === 'shortcuts' && s[2] === 'order' && s.length === 3 && m === 'POST') {
      return readJSONBody(req, 16384).then(function (body) {
        if (!Array.isArray(body.ids)) return sendJSON(res, 400, { error: 'ids-required' });
        store.reorderShortcuts(body.ids.filter(function (x) { return typeof x === 'string' && storeMod.SHORTCUT_ID.test(x); }));
        sendJSON(res, 200, { rev: store.state.rev });
      }).catch(function (e) { bodyError(res, e); });
    }
    if (s[1] === 'shortcuts' && s.length === 3 && m === 'DELETE') {
      if (!storeMod.SHORTCUT_ID.test(s[2])) return sendJSON(res, 400, { error: 'bad-id' });
      if (!store.removeShortcut(s[2])) return sendJSON(res, 404, { error: 'not-found' });
      return sendJSON(res, 200, { rev: store.state.rev });
    }
    refuseBody(req, res, 404, { error: 'not-found' });
  }

  function handle(req, res) {
    var ip = netu.normalize(req.socket.remoteAddress);
    if (!netu.isPrivate(ip)) { req.socket.destroy(); return; }
    baseHeaders(res);
    if (!netu.hostAllowed(req.headers.host)) return refuseBody(req, res, 421, { error: 'host' });
    var parsed = urlmod.parse(req.url || '/', true);
    var segs = splitPath(parsed.pathname);
    if (!segs) return refuseBody(req, res, 400, { error: 'bad-path' });
    var ctx = { req: req, res: res, ip: ip, loopback: netu.isLoopback(ip), method: req.method, segs: segs, query: parsed.query || {} };
    try {
      var top = segs[0];
      if (top === 'health' && segs.length === 1) {
        corsOpen(res);
        if (ctx.method === 'OPTIONS') return sendEmpty(res, 204);
        return sendJSON(res, 200, { ok: true, name: 'Glass Home', version: VERSION });
      }
      if (top === 'local') return handleLocal(ctx);
      if (top === 'media') {
        if (ctx.method === 'OPTIONS') { corsOpen(res); return sendEmpty(res, 204); }
        return handleMedia(ctx);
      }
      if (top === 'api') return handleApi(ctx);
      if (ctx.method !== 'GET') return refuseBody(req, res, 405, { error: 'method' });
      if (segs.length === 1 && (top === '' || top === 'index.html')) return routeWebsite(ctx);
      if (segs.length === 1 && (top === 'apple-touch-icon.png' || top === 'favicon.png')) {
        return serveFile(res, path.join(serviceDir, 'web', top), 'image/png', 86400);
      }
      if (segs.length === 1 && top === 'bg.jpg') {
        var wp = wallpaperOfTheDay();
        if (!wp) return sendJSON(res, 404, { error: 'not-found' });
        return serveFile(res, wp, 'image/jpeg', 3600);
      }
      sendJSON(res, 404, { error: 'not-found' });
    } catch (e) {
      note('handler crashed: ' + (e && e.stack ? e.stack : e));
      if (!res.headersSent) sendJSON(res, 500, { error: 'server' });
      else res.destroy();
    }
  }

  // ---------- lifecycle ----------
  function chooseDataDir() {
    var pkg = cfg.packageId;
    var home = process.env.HOME;
    var candidates = [];
    if (opts.dataDir) candidates.push({ dir: opts.dataDir, kind: 'custom' });
    if (cfg.dataDir) candidates.push({ dir: cfg.dataDir, kind: 'custom' });
    // The package's private data directory: removed when the app is deleted.
    candidates.push({ dir: '/opt/usr/home/owner/apps_rw/' + pkg + '/data/glasshome', kind: 'app-data' });
    if (home) candidates.push({ dir: path.join(home, 'apps_rw', pkg, 'data', 'glasshome'), kind: 'app-data' });
    // Last resort: survives uninstalling, so it is only used if the above fail.
    candidates.push({ dir: '/home/owner/share/' + pkg, kind: 'shared' });
    return storeMod.pickDataDir(candidates, note);
  }

  function listenAll(cb) {
    var pending = hosts.length;
    var failed = null;
    listening = [];
    hosts.forEach(function (host) {
      var attempt = 0;
      var srv = http.createServer(handle);
      srv.timeout = 120000;
      srv.keepAliveTimeout = 5000;
      if ('headersTimeout' in srv) srv.headersTimeout = 30000;
      srv.on('connection', function (sock) {
        if (!netu.isPrivate(sock.remoteAddress)) sock.destroy();
      });
      function tryListen() {
        attempt += 1;
        srv.once('error', onError);
        srv.listen(cfg.port, host, function () {
          srv.removeListener('error', onError);
          srv.on('error', function (e) { note('server error: ' + e.message); });
          servers.push(srv);
          listening.push(host + ':' + cfg.port);
          if (--pending === 0) cb(failed);
        });
      }
      function onError(e) {
        if (e.code === 'EADDRINUSE' && attempt < 6) {
          note('port ' + cfg.port + ' busy on ' + host + ', retrying');
          return setTimeout(tryListen, 2000);
        }
        note('cannot listen on ' + host + ':' + cfg.port + ' (' + (e.code || e.message) + ')');
        failed = failed || e;
        if (--pending === 0) cb(failed);
      }
      tryListen();
    });
  }

  function start(cb) {
    cb = cb || function () {};
    try {
      dataInfo = chooseDataDir();
      if (!dataInfo) throw new Error('no writable data directory');
      store = new storeMod.Store(dataInfo.dir, note);
      store.load();
      var shown = store.readShown();
      if (shown && store.state.password && shown.id === store.state.password.id) plain = shown;
    } catch (e) {
      note('storage failed: ' + e.message);
      return cb(e);
    }
    loadTemplate();
    var ready = store.state.password ? Promise.resolve() : setPassword(auth.generatePassword(), true);
    ready.then(function () {
      try {
        fs.writeFileSync(path.join(dataInfo.dir, 'diagnostics.json'), JSON.stringify({
          at: new Date().toISOString(), version: VERSION, node: process.version, versions: process.versions,
          dataDir: dataInfo.dir, dataKind: dataInfo.kind, port: cfg.port, lan: netu.lanAddresses()
        }, null, 2));
      } catch (e) { /* diagnostics only */ }
      store.state.shortcuts.forEach(function (x) { if (x.iconState === 'retry' || x.iconState === 'pending') enqueue(x.id); });
      sweepTimer = setInterval(function () { limiter.sweep(); }, 60000);
      if (sweepTimer.unref) sweepTimer.unref();
      listenAll(function (err) {
        log('Glass Home service ' + VERSION + ' on ' + listening.join(', ') + ' (node ' + process.version + ', ' + engineName() + ', data ' + dataInfo.dir + ')');
        cb(listening.length ? null : err, { listening: listening.slice(), dataDir: dataInfo.dir });
      });
    }).catch(function (e) { note('start failed: ' + e.message); cb(e); });
  }

  function stop(cb) {
    clearInterval(sweepTimer);
    var n = servers.length;
    if (!n) { if (cb) cb(); return; }
    servers.forEach(function (s) { s.close(function () { if (--n === 0 && cb) cb(); }); });
    servers = [];
  }

  return {
    start: start,
    stop: stop,
    info: function () { return { listening: listening.slice(), dataDir: dataInfo && dataInfo.dir, port: cfg.port }; },
    localKey: function () { return localKey; },
    // For dev/run.js only (not reachable over HTTP): signs a browser in for screenshots.
    devCreateSession: function () { return createSession(null); },
    devState: function () { return localState(); }
  };
}

module.exports = { createService: createService, VERSION: VERSION, splitPath: splitPath };

