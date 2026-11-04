// Glass Home service - outbound fetches: website icons and YouTube details.
// Node 12 API only (http/https/dns/zlib; no global fetch, no AbortController).
//
// Privacy: icons come from the site itself (its declared apple-touch-icon,
// web manifest or <link rel=icon>), never from Google's or DuckDuckGo's
// favicon services, and each site is asked once, when the shortcut is added.
// Safety: only public internet addresses are contacted, so a shortcut can
// never make the TV probe the home network.
'use strict';
var http = require('http');
var https = require('https');
var dns = require('dns');
var zlib = require('zlib');
var URLc = require('./compat.js').URL;
var netu = require('./netutil.js');
var img = require('./imageutil.js');
var yt = require('../js/ytparse.js');

var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  options = options || {};
  var wantAll = !!options.all;
  dns.lookup(hostname, { all: true, family: options.family || 0, hints: options.hints || 0 }, function (err, list) {
    if (err) return callback(err);
    var ok = (list || []).filter(function (a) { return netu.isPublicUnicast(a.address); });
    if (!ok.length) {
      var e = new Error('blocked: ' + hostname + ' is not a public address');
      e.code = 'EBLOCKED';
      return callback(e);
    }
    if (wantAll) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

function decoderFor(encoding) {
  var e = String(encoding || '').toLowerCase().trim();
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br' && typeof zlib.createBrotliDecompress === 'function') return zlib.createBrotliDecompress();
  return null;
}

// GET a URL. Resolves { status, headers, body (Buffer), url } after redirects.
function get(url, opts) {
  opts = opts || {};
  var maxBytes = opts.maxBytes || 512 * 1024;
  var timeout = opts.timeout || 8000;
  var redirects = opts.redirects == null ? 5 : opts.redirects;
  return new Promise(function (resolve, reject) {
    var u;
    try { u = new URLc(url); } catch (e) { return reject(new Error('bad url')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('unsupported scheme'));
    if (u.username || u.password) return reject(new Error('credentials in url'));
    var hostname = u.hostname.replace(/^\[|\]$/g, '');
    if (netu.isIpLiteral(hostname) && !netu.isPublicUnicast(hostname)) return reject(new Error('blocked address'));
    var mod = u.protocol === 'https:' ? https : http;
    var enc = 'gzip, deflate' + (typeof zlib.createBrotliDecompress === 'function' ? ', br' : '');
    var done = false;
    var timer = null;
    var req;
    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { try { req.destroy(); } catch (e) { /* ignore */ } reject(err); } else resolve(value);
    }
    req = mod.request({
      protocol: u.protocol,
      hostname: hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'GET',
      lookup: guardedLookup,
      headers: {
        'User-Agent': UA,
        'Accept': opts.accept || '*/*',
        'Accept-Language': 'en,*;q=0.5',
        'Accept-Encoding': enc
      }
    }, function (res) {
      var status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return finish(new Error('too many redirects'));
        var next;
        try { next = new URLc(res.headers.location, u).href; } catch (e) { return finish(new Error('bad redirect')); }
        clearTimeout(timer);
        done = true;
        get(next, { maxBytes: maxBytes, timeout: timeout, accept: opts.accept, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      var stream = res;
      var dec = decoderFor(res.headers['content-encoding']);
      if (dec) { res.pipe(dec); stream = dec; }
      var chunks = [];
      var size = 0;
      stream.on('data', function (c) {
        size += c.length;
        if (size > maxBytes) { res.destroy(); return finish(new Error('too large')); }
        chunks.push(c);
      });
      stream.on('end', function () {
        finish(null, { status: status, headers: res.headers, body: Buffer.concat(chunks), url: u.href });
      });
      stream.on('error', function (e) { finish(e); });
      res.on('error', function (e) { finish(e); });
    });
    timer = setTimeout(function () { finish(new Error('timeout')); }, timeout);
    req.on('error', function (e) { finish(e); });
    req.end();
  });
}

// ---------- reading a site's page ----------
// Pages come from anywhere, so reading them must stay cheap whatever they
// contain: the service is one thread, and a slow parse freezes the website
// and the TV app's channel with it. Regular expressions with [^>]* or
// ([a-z-]+)\s*= used to do this and took 12 s to minutes on hostile pages
// (unclosed "<link" or "<title" tags, one huge tag). Now everything is found
// with plain searches and short forward scans, and the work is capped.
var MAX_HTML_CHARS = 400000;    // of a page, read for its title and icon links
var MAX_LINK_TAGS = 200;        // <link> tags looked at per page
var MAX_TITLE_TAGS = 20;        // <title> tags looked at per page
var MAX_TAG_CHARS = 2048;       // longest tag read; longer ones are skipped
var MAX_ATTRS = 32;             // attributes kept per tag
var MAX_MANIFEST_ICONS = 64;    // icons looked at in a web manifest

function isSpace(c) { return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f'; }

// Reads a start tag's attributes, starting at s[i] (just after the tag name),
// the way an HTML tokenizer does: names are lower-cased, the first of a
// repeated name wins, values are "double-quoted", 'single-quoted' or bare, and
// the tag ends at the first '>' outside a quoted value. Returns
// { attrs, end } (end = index of that '>'), or null if the tag does not end
// before `limit`. Each character is read once, with no backtracking.
function readTag(s, i, limit) {
  var out = Object.create(null);
  var kept = 0;
  if (limit > s.length) limit = s.length;
  while (i < limit) {
    var c = s.charAt(i);
    if (c === '>') return { attrs: out, end: i };
    if (isSpace(c) || c === '/') { i += 1; continue; }
    var start = i;
    i += 1;                                  // a name may start with any other character, even '='
    while (i < limit) {
      c = s.charAt(i);
      if (isSpace(c) || c === '/' || c === '>' || c === '=') break;
      i += 1;
    }
    var name = s.slice(start, i).toLowerCase();
    while (i < limit && isSpace(s.charAt(i))) i += 1;
    var value = '';
    if (i < limit && s.charAt(i) === '=') {
      i += 1;
      while (i < limit && isSpace(s.charAt(i))) i += 1;
      c = s.charAt(i);
      if (i < limit && (c === '"' || c === "'")) {
        var close = s.slice(i + 1, limit).indexOf(c);
        if (close < 0) return null;
        value = s.slice(i + 1, i + 1 + close);
        i += close + 2;
      } else {
        start = i;
        while (i < limit) {
          c = s.charAt(i);
          if (isSpace(c) || c === '>') break;
          i += 1;
        }
        value = s.slice(start, i);
      }
    }
    if (kept < MAX_ATTRS && !(name in out)) { out[name] = value; kept += 1; }
  }
  return null;
}

// The attributes of the first MAX_LINK_TAGS <link> tags. The search for
// "<link" is a plain substring search, each tag is read with readTag, and a
// tag longer than MAX_TAG_CHARS is skipped (it still counts towards the cap).
function linkTags(html) {
  var out = [];
  var re = /<link(?=[\s\/>])/gi;
  var m;
  for (var n = 0; n < MAX_LINK_TAGS && (m = re.exec(html)); n++) {
    var t = readTag(html, m.index + 5, m.index + MAX_TAG_CHARS);
    if (!t) continue;
    out.push(t.attrs);
    re.lastIndex = t.end + 1;
  }
  return out;
}

// The text of the first <title> holding 1-200 characters and no '<', as the
// old /<title[^>]*>([^<]{1,200})<\/title>/i matched, without its slow cases.
function pageTitle(html) {
  var re = /<title(?=[\s\/>])/gi;
  var m;
  for (var n = 0; n < MAX_TITLE_TAGS && (m = re.exec(html)); n++) {
    var gt = html.slice(m.index + 6, m.index + MAX_TAG_CHARS).indexOf('>');
    if (gt < 0) continue;
    var from = m.index + 6 + gt + 1;
    var lt = html.slice(from, from + 201).indexOf('<');
    if (lt < 1) continue;                    // empty, or longer than 200 characters
    if (html.slice(from + lt, from + lt + 8).toLowerCase() !== '</title>') continue;
    return html.slice(from, from + lt);
  }
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function rank(sizes, href, type) {
  if (/svg/i.test(type || '') || /\.svg(\?|$)/i.test(href) || /any/i.test(sizes || '')) return 170;
  var best = 0;
  String(sizes || '').split(/\s+/).forEach(function (s) {
    var m = /^(\d+)x\d+$/i.exec(s);
    if (m) best = Math.max(best, +m[1]);
  });
  return best;
}

function resolveUrl(href, base) {
  try { return new URLc(decodeEntities(href), base).href; } catch (e) { return null; }
}

// What a page declares: { title, icons: [{ url, size }], manifests: [url] }.
// URLs are absolute (resolved against `base`) but not yet filtered by scheme.
function parsePage(html, base) {
  html = String(html).slice(0, MAX_HTML_CHARS);
  var t = pageTitle(html);
  var icons = [];
  var manifests = [];
  linkTags(html).forEach(function (a) {
    var rel = String(a.rel || '').toLowerCase();
    if (!a.href) return;
    var abs = resolveUrl(a.href, base);
    if (!abs) return;
    if (/apple-touch-icon/.test(rel)) icons.push({ url: abs, size: rank(a.sizes, abs) || 180 });
    else if (/(^|\s)icon(\s|$)/.test(rel)) icons.push({ url: abs, size: rank(a.sizes, abs, a.type) || 16 });
    else if (rel === 'manifest') manifests.push(abs);
  });
  return { title: t ? decodeEntities(t).replace(/\s+/g, ' ').trim() : null, icons: icons, manifests: manifests };
}

// Finds the best icon a site declares. Resolves
// { title, icon: { bytes, ext, type, width, height, url } | null }.
function findSiteIcon(pageUrl) {
  var candidates = [];
  var base = pageUrl;
  var title = null;
  function add(url, size) { if (url && /^https?:/i.test(url)) candidates.push({ url: url, size: size }); }

  return get(pageUrl, { accept: 'text/html,application/xhtml+xml', maxBytes: 600 * 1024, timeout: 9000 })
    .then(function (r) {
      base = r.url;
      if (r.status >= 400) return;
      var page = parsePage(r.body.toString('utf8'), base);
      title = page.title;
      page.icons.forEach(function (c) { add(c.url, c.size); });
      var manifests = page.manifests;
      if (!manifests.length) return;
      return get(manifests[0], { accept: 'application/manifest+json,application/json', maxBytes: 200 * 1024, timeout: 6000 })
        .then(function (m) {
          var man = JSON.parse(m.body.toString('utf8'));
          var list = Array.isArray(man.icons) ? man.icons.slice(0, MAX_MANIFEST_ICONS) : [];
          list.forEach(function (i) {
            if (!i || !i.src || /monochrome/.test(i.purpose || '')) return;
            var abs = resolveUrl(i.src, m.url);
            if (abs) add(abs, rank(i.sizes, abs, i.type));
          });
        })
        .catch(function () { /* manifest optional */ });
    })
    .catch(function () { /* page unreachable: try the well-known paths */ })
    .then(function () {
      var origin;
      try { origin = new URLc(base).origin; } catch (e) { return null; }
      add(origin + '/apple-touch-icon.png', 120);
      add(origin + '/favicon.ico', 16);
      candidates.sort(function (x, y) { return y.size - x.size; });
      var seen = {};
      candidates = candidates.filter(function (c) { if (seen[c.url]) return false; seen[c.url] = true; return true; }).slice(0, 8);
      var fallback = null;
      function next(i) {
        if (i >= candidates.length) return Promise.resolve(fallback);
        return get(candidates[i].url, { accept: 'image/*', maxBytes: 1024 * 1024, timeout: 7000 })
          .then(function (r) {
            if (r.status !== 200) return next(i + 1);
            var info = img.sniff(r.body);
            if (!info) return next(i + 1);
            if (info.ext === 'svg' && r.body.length > 200 * 1024) return next(i + 1);
            var icon = { bytes: r.body, ext: info.ext, type: info.type, width: info.width, height: info.height, url: candidates[i].url };
            if (info.width >= 64 || info.ext === 'svg') return icon;
            if (!fallback || info.width > fallback.width) fallback = icon;
            return next(i + 1);
          }, function () { return next(i + 1); });
      }
      return next(0);
    })
    .then(function (icon) { return { title: title, icon: icon || null }; });
}

// YouTube title, channel and thumbnail URL from the key-less oEmbed endpoint.
function youtubeInfo(p) {
  var link = yt.canonicalUrl(p);
  return get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(link), { accept: 'application/json', maxBytes: 64 * 1024, timeout: 7000 })
    .then(function (r) {
      if (r.status !== 200) return null;
      var j = JSON.parse(r.body.toString('utf8'));
      return { title: String(j.title || '').slice(0, 200), author: String(j.author_name || '').slice(0, 120), thumbnail: String(j.thumbnail_url || '') };
    })
    .catch(function () { return null; });
}

// Best available thumbnail. A missing size comes back as a 120x90 grey JPEG
// (sometimes with HTTP 404), so anything 120 px wide or less counts as missing.
function youtubeThumb(p, info) {
  var urls = [];
  if (p.videoId) {
    ['maxresdefault', 'hq720', 'sddefault', 'hqdefault', 'mqdefault'].forEach(function (n) {
      urls.push('https://i.ytimg.com/vi/' + p.videoId + '/' + n + '.jpg');
    });
  }
  if (info && /^https:\/\/i\d?\.ytimg\.com\//.test(info.thumbnail)) urls.push(info.thumbnail);
  function next(i) {
    if (i >= urls.length) return Promise.resolve(null);
    return get(urls[i], { accept: 'image/jpeg,image/*', maxBytes: 1024 * 1024, timeout: 7000 })
      .then(function (r) {
        if (r.status !== 200) return next(i + 1);
        var size = img.jpegSize(r.body);
        if (!size || size.width <= 120) return next(i + 1);
        return { bytes: r.body, width: size.width, height: size.height, url: urls[i] };
      }, function () { return next(i + 1); });
  }
  return next(0);
}

module.exports = {
  get: get,
  findSiteIcon: findSiteIcon,
  youtubeInfo: youtubeInfo,
  youtubeThumb: youtubeThumb,
  parsePage: parsePage,            // exported for dev/test-parsers.js
  readTag: readTag
};
