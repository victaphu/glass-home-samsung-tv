// Optional ordinary app launches through this TV's existing Vetro API.
'use strict';
var http = require('http');
var vetro = require('./vetro.js');
var APP_ID = /^[A-Za-z0-9_.-]{1,120}$/;
var CONNECT_MS = 1500, LAUNCH_MS = 30000, MAX_BYTES = 65536;

function request(address, route, body) {
  return new Promise(function (resolve, reject) {
    var req, timer, connected = false, done = false;
    function fail() {
      if (done) return;
      done = true; clearTimeout(timer);
      var err = new Error('Vetro request was not confirmed');
      err.beforeConnect = !connected;
      reject(err);
      try { if (req) req.destroy(); } catch (e) { /* the result is already settled */ }
    }
    function arm(ms) { clearTimeout(timer); timer = setTimeout(fail, ms); }
    arm(CONNECT_MS);
    try {
      var payload = body === undefined ? null : JSON.stringify(body);
      var headers = { Accept: 'application/json', Connection: 'close' };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      req = http.request({ hostname: address, localAddress: address, family: 4, port: 8099,
        path: route, method: payload === null ? 'GET' : 'POST', headers: headers, agent: false }, function (res) {
        connected = true;
        var chunks = [], size = 0;
        res.on('data', function (chunk) {
          if (done) return;
          var bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_BYTES) { fail(); return; }
          chunks.push(bytes);
        });
        res.on('error', fail); res.on('aborted', fail);
        res.on('end', function () {
          if (done) return;
          var data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { fail(); return; }
          done = true; clearTimeout(timer);
          resolve({ status: res.statusCode, data: data });
        });
      });
      req.on('socket', function (socket) {
        function ready() {
          if (done) return;
          connected = true; arm(payload === null ? CONNECT_MS : LAUNCH_MS);
        }
        if (socket.connecting) socket.once('connect', ready); else ready();
      });
      req.on('error', fail);
      req.end(payload);
    } catch (e) { fail(); }
  });
}

function createLauncher(readCatalog) {
  var pending = false, last = null;
  function result(appId, outcome, reason) {
    last = { appId: appId, outcome: outcome, reason: reason || null, at: Date.now() };
    return last;
  }
  function launch(appId) {
    if (typeof appId !== 'string' || !APP_ID.test(appId)) return Promise.reject(new Error('Invalid app ID'));
    if (pending) return Promise.resolve({ appId: appId, outcome: 'busy' });
    var catalog = readCatalog.current(), address = catalog && catalog.address;
    if (!catalog || !catalog.available || !catalog.apps.some(function (a) { return a.appId === appId; })) {
      return Promise.resolve(result(appId, 'fallback', 'not-listed'));
    }
    var local = address === '127.0.0.1';
    try { local = local || vetro.localLanAddresses().indexOf(address) >= 0; } catch (e) { /* stale address uses native launch */ }
    if (!local) return Promise.resolve(result(appId, 'fallback', 'unavailable'));
    pending = true;
    // This read happens before any launch request. An unavailable root connection
    // can safely use the app's native launcher without risking two requests.
    return request(address, '/status').then(function (state) {
      if (state.status !== 200 || !state.data || !state.data.agent || state.data.agent.connected !== true) {
        return result(appId, 'fallback', 'unavailable');
      }
      return request(address, '/apps/launch', { appId: appId }).then(function (reply) {
        if (reply.status === 200 && reply.data && reply.data.ok === true && reply.data.sent === 1) {
          return result(appId, 'accepted');
        }
        if (reply.status === 404 || reply.status === 405) return result(appId, 'fallback', 'unsupported');
        return result(appId, 'unknown', 'unconfirmed');
      }, function (err) {
        // Never resend a POST to a second address or fall back after an uncertain
        // submission: Vetro may still have its launch in the command queue.
        return result(appId, err.beforeConnect ? 'fallback' : 'unknown', err.beforeConnect ? 'unavailable' : 'unconfirmed');
      });
    }, function () { return result(appId, 'fallback', 'unavailable'); }).then(function (value) {
      pending = false; return value;
    }, function (err) { pending = false; throw err; });
  }
  launch.status = function () { return { pending: pending, last: last }; };
  return launch;
}

module.exports = { version: 1, createLauncher: createLauncher };
