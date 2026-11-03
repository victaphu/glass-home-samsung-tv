// Read Vetro's Samsung Home app list on this TV through a fixed endpoint.
'use strict';
var http = require('http');
var netutil = require('./netutil');
var APP_ID = /^[A-Za-z0-9_.-]{1,120}$/;
var VERSION = 3;

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

function requestApps(packageId, address, timeout) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer;
    var req;
    function finish(err, data) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        err.vetro.address = address;
        reject(err);
        try { if (req) req.destroy(); } catch (e) { /* failure is already reported */ }
      }
      else { data.address = address; resolve(data); }
    }
    timer = setTimeout(function () { finish(failure('timeout')); }, timeout);
    try {
      // Register request errors before sending, using the same request/end
      // lifecycle as Glass Home's other HTTP client. Close this one-shot read.
      req = http.request({
        hostname: address, localAddress: address, family: 4,
        port: 8099, path: '/dock', method: 'GET',
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

// Some TVs isolate package labels on 127.0.0.1 while permitting ordinary
// networking through their LAN address. Use only addresses assigned to this
// device, and bind the source to that same address. No discovery of other
// devices, configurable remote hosts, redirects, or security-policy changes.
function localLanAddresses() {
  var addresses = [];
  netutil.lanAddresses().forEach(function (entry) {
    var ip = netutil.parseV4(entry.address);
    if (!ip || !(ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
        (ip[0] === 192 && ip[1] === 168))) return;
    var address = ip.join('.');
    if (addresses.indexOf(address) < 0) addresses.push(address);
  });
  return addresses.slice(0, 3);
}

function readApps(packageId) {
  var until = Date.now() + 25000;
  var attempted = ['127.0.0.1'];
  return requestApps(packageId, attempted[0], 25000).catch(function (err) {
    if (err.vetro.code !== 'connection' ||
        ['EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM'].indexOf(err.vetro.detail) < 0) throw err;
    var addresses;
    try { addresses = localLanAddresses(); } catch (e) { throw err; }
    function next(index, lastError) {
      if (index >= addresses.length) throw lastError;
      var remaining = until - Date.now();
      if (remaining <= 0) throw failure('timeout');
      attempted.push(addresses[index]);
      return requestApps(packageId, addresses[index], remaining).catch(function (error) {
        // A response means Vetro was reached; do not hide HTTP or data errors
        // behind another request. All attempts share the 25-second deadline.
        if (error.vetro.code !== 'connection') throw error;
        return next(index + 1, error);
      });
    }
    return next(0, err);
  }).catch(function (err) {
    err.vetro.attempted = attempted;
    throw err;
  });
}

// Coalesce requests and avoid repeatedly waking Vetro's catalog reader.
function createReader(packageId, onError) {
  var pending = null, cached = null, at = 0;
  function read(refresh) {
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
  }
  // Launches use the already discovered catalog without starting a slow refresh.
  read.current = function () { return cached; };
  return read;
}

module.exports = { version: VERSION, appsFrom: appsFrom, readApps: readApps, createReader: createReader, localLanAddresses: localLanAddresses };
