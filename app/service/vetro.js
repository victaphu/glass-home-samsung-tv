// Read Vetro's Samsung Home app list on this TV. This is deliberately a
// fixed, read-only request, not a proxy for Vetro's control or shell APIs.
'use strict';
var http = require('http');
var APP_ID = /^[A-Za-z0-9_.-]{1,120}$/;

function appsFrom(data, packageId) {
  if (!data || !Array.isArray(data.entries)) throw new Error('list-unavailable');
  var seen = Object.create(null);
  return data.entries.slice(0, 100).map(function (e) {
    // Vetro opens TV Plus through its viewer. Glass Home launches the TV
    // Plus app directly, using the same ID as its configured TV Plus tile.
    if (e && e.slug === 'tvplus' && e.appId === 'org.tizen.tv-viewer') {
      return { appId: 'com.samsung.tv.tvPlusDeeplinker', label: e.label };
    }
    return e;
  }).filter(function (e) {
    if (!e || e.system || e.panel || e.source || typeof e.appId !== 'string' || !APP_ID.test(e.appId)) return false;
    if (typeof e.label !== 'string' || !e.label.trim()) return false;
    // Live TV is an input, configured separately in Glass Home.
    if (e.appId === 'org.tizen.tv-viewer') return false;
    if (e.appId === packageId || e.appId.indexOf(packageId + '.') === 0 || seen[e.appId]) return false;
    seen[e.appId] = true;
    return true;
  }).map(function (e) {
    return { appId: e.appId, label: e.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) };
  });
}

function readApps(packageId) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer;
    var req;
    function finish(err, data) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { if (req) req.destroy(); reject(new Error(err)); }
      else resolve(data);
    }
    timer = setTimeout(function () { finish('unavailable'); }, 25000);
    req = http.get({ hostname: '127.0.0.1', port: 8099, path: '/dock', agent: false }, function (res) {
      if (res.statusCode !== 200) { res.resume(); finish('unavailable'); return; }
      var chunks = [], size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > 256 * 1024) { res.destroy(); finish('invalid-list'); return; }
        chunks.push(chunk);
      });
      res.on('error', function () { finish('unavailable'); });
      res.on('aborted', function () { finish('unavailable'); });
      res.on('end', function () {
        if (done) return;
        try {
          var apps = appsFrom(JSON.parse(Buffer.concat(chunks).toString('utf8')), packageId);
          finish(null, { available: apps.length > 0, apps: apps });
        } catch (e) { finish('invalid-list'); }
      });
    });
    req.on('error', function () { finish('unavailable'); });
  });
}

// Coalesce requests and avoid repeatedly waking Vetro's catalog reader.
function createReader(packageId) {
  var pending = null, cached = null, at = 0;
  return function () {
    if (cached && Date.now() - at < 30000) return Promise.resolve(cached);
    if (!pending) pending = readApps(packageId).catch(function () {
      return { available: false, apps: [] };
    }).then(function (result) {
      cached = result; at = Date.now(); pending = null;
      return result;
    });
    return pending;
  };
}

module.exports = { appsFrom: appsFrom, readApps: readApps, createReader: createReader };
