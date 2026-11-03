// Read Vetro's Samsung Home app list on this TV. This is deliberately a
// fixed, read-only request, not a proxy for Vetro's control or shell APIs.
'use strict';
var http = require('http');
var APP_ID = /^[A-Za-z0-9_.-]{1,120}$/;
var VERSION = 2;

function clean(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
}

function failure(code, cause, status) {
  var messages = {
    timeout: 'Vetro did not respond within 25 seconds.',
    request: 'The Vetro request could not be started.',
    connection: 'The connection to Vetro failed.',
    response: 'The Vetro response was interrupted.',
    http: 'Vetro returned HTTP ' + status + '.',
    size: 'The Vetro app list exceeds 256 KiB.',
    body: 'The Vetro response could not be decoded.',
    json: 'The Vetro response is not valid JSON.',
    catalog: 'The Vetro response does not contain an app list.',
    empty: 'Vetro has no launchable apps.'
  };
  var err = new Error(messages[code] || 'The Vetro app list could not be read.');
  err.vetro = {
    code: code,
    detail: clean(cause && (cause.code || cause.name)),
    message: clean(cause && cause.message || err.message)
  };
  if (status) err.vetro.status = status;
  return err;
}

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
      if (err) {
        reject(err);
        try { if (req) req.destroy(); } catch (e) { /* failure is already reported */ }
      }
      else resolve(data);
    }
    timer = setTimeout(function () { finish(failure('timeout')); }, 25000);
    try {
      // Register request errors before sending, using the same request/end
      // lifecycle as Glass Home's other HTTP client. Close this one-shot read.
      req = http.request({
        hostname: '127.0.0.1', port: 8099, path: '/dock', method: 'GET',
        headers: { Accept: 'application/json', Connection: 'close' }
      }, function (res) {
        if (res.statusCode !== 200) { finish(failure('http', null, res.statusCode)); return; }
        var chunks = [], size = 0;
        res.on('data', function (chunk) {
          if (done) return;
          try {
            var bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 256 * 1024) { finish(failure('size')); return; }
            chunks.push(bytes);
          } catch (e) { finish(failure('body', e)); }
        });
        res.on('error', function (e) { finish(failure('response', e)); });
        res.on('aborted', function () { finish(failure('response')); });
        res.on('end', function () {
          if (done) return;
          var stage = 'body';
          try {
            var text = Buffer.concat(chunks).toString('utf8');
            stage = 'json';
            var data = JSON.parse(text);
            stage = 'catalog';
            var apps = appsFrom(data, packageId);
            var result = { available: apps.length > 0, apps: apps };
            if (!apps.length) result.error = failure('empty').vetro;
            finish(null, result);
          } catch (e) { finish(failure(stage, e)); }
        });
      });
      req.on('error', function (e) { finish(failure('connection', e)); });
      req.end();
    } catch (e) { finish(failure('request', e)); }
  });
}

// Coalesce requests and avoid repeatedly waking Vetro's catalog reader.
function createReader(packageId, onError) {
  var pending = null, cached = null, at = 0;
  return function (refresh) {
    if (!refresh && cached && Date.now() - at < 30000) return Promise.resolve(cached);
    if (!pending) pending = readApps(packageId).catch(function (err) {
      return { available: false, apps: [], error: err.vetro || failure('request', err).vetro };
    }).then(function (result) {
      if (result.error && onError) {
        try { onError(result.error); } catch (e) { /* diagnostics must not break reads */ }
      }
      cached = result; at = Date.now(); pending = null;
      return result;
    });
    return pending;
  };
}

module.exports = { version: VERSION, appsFrom: appsFrom, readApps: readApps, createReader: createReader };
