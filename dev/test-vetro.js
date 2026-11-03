#!/usr/bin/env node
// Vetro reader and saved selection: real loopback HTTP plus a TV-client VM.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const EventEmitter = require('events');
const vetro = require('../app/service/vetro.js');
const root = path.join(__dirname, '..');
let checks = 0;
function equal(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
  checks++;
}
const catalog = { entries: [
  { slug: 'netflix', appId: 'org.tizen.netflix-app', label: 'Netflix' },
  { slug: 'spotify', appId: 'test.Spotify', label: 'Spotify' },
  { slug: 'duplicate', appId: 'test.Spotify', label: 'Duplicate' },
  { slug: 'settings', appId: 'key:XF86SysMenu', label: 'Settings', system: true },
  { slug: 'home', appId: 'sys:com.samsung.tv.csfs', label: 'Samsung Home', system: true },
  { slug: 'livetv', appId: 'org.tizen.tv-viewer', label: 'Live TV' },
  { slug: 'tvplus', appId: 'org.tizen.tv-viewer', label: 'Samsung TV Plus' },
  { slug: 'glass', appId: 'GlassHome1.GlassHome', label: 'Glass Home' },
  { slug: 'service', appId: 'GlassHome1.Photos', label: 'Photos' },
  { appId: 'bad;command', label: 'Bad' },
  { appId: 'valid.Id', label: '' }
] };
const expected = [
  { appId: 'org.tizen.netflix-app', label: 'Netflix' },
  { appId: 'test.Spotify', label: 'Spotify' },
  { appId: 'com.samsung.tv.tvPlusDeeplinker', label: 'Samsung TV Plus' }
];
function client(stored, config, response) {
  const GH = {
    config: Object.assign({ apps: [{ key: 'netflix', label: 'Netflix', ids: ['org.tizen.netflix-app'], names: ['^netflix$'], storeId: '11101200001' }] }, config),
    ls: { get: k => stored[k], set: (k, v) => { stored[k] = JSON.parse(JSON.stringify(v)); } },
    data: { vetroApps: () => response() }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/js/vetro-apps.js'), 'utf8'), { window: { GH } });
  return GH.vetro;
}

function simulatedReader(options) {
  let now = 0;
  const calls = [], durations = [], timers = new Map();
  const network = { exports: {} }, module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/service/netutil.js'), 'utf8'), {
    module: network, require: () => ({ networkInterfaces: () => {
      if (options.interfaceError) throw new Error('interfaces unavailable');
      return options.interfaces || {};
    } })
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/service/vetro.js'), 'utf8'), {
    module, Buffer, Date: { now: () => now },
    require: name => name === './netutil' ? network.exports : { request: (request, onResponse) => {
      calls.push(request);
      const outcome = options.responses[request.hostname] || { error: 'ECONNREFUSED' };
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        now += outcome.elapsed || 0;
        if (outcome.hang) return;
        if (outcome.error) {
          req.emit('error', Object.assign(new Error('connect ' + outcome.error + ' ' + request.hostname), { code: outcome.error }));
        } else {
          const res = new EventEmitter();
          res.statusCode = outcome.status || 200;
          onResponse(res);
          res.emit('data', outcome.body === undefined ? JSON.stringify(catalog) : outcome.body);
          res.emit('end');
        }
      };
      return req;
    } },
    setTimeout: (fn, delay) => { timers.set(fn, delay); durations.push(delay); return fn; },
    clearTimeout: fn => timers.delete(fn)
  });
  return { reader: module.exports, calls, durations, timers };
}

(async () => {
  equal(vetro.appsFrom(catalog, 'GlassHome1'), expected, 'filter controls, inputs, duplicates, self and invalid IDs');
  assert.throws(() => vetro.appsFrom({}, 'GlassHome1')); checks++;
  equal(vetro.appsFrom({ entries: [] }, 'GlassHome1'), [], 'empty catalog is not an app source');
  let reply = { available: true, apps: expected };
  let store = {};
  let V = client(store, {}, () => Promise.resolve(reply));
  equal(V.definitions().map(d => d.key), ['netflix'], 'configured list is used before discovery');
  await V.refresh();
  equal(V.definitions().length, 3, 'discovery automatically selects all apps');
  V.save(['test.Spotify', 'org.tizen.netflix-app']);
  equal(V.definitions().map(d => d.label), ['Netflix', 'Spotify'], 'Samsung order, independent of click order');
  equal(V.definitions()[0].storeId, '11101200001', 'known apps retain launch metadata');
  V = client(store, {}, () => Promise.reject(new Error('offline')));
  await V.refresh();
  equal(V.definitions().map(d => d.label), ['Netflix', 'Spotify'], 'selection and apps survive restart with Vetro offline');
  V.save([]);
  equal(V.definitions(), [], 'empty selection is intentional, not a fallback');
  store = {};
  V = client(store, {}, () => Promise.resolve(reply));
  equal(V.definitions().map(d => d.key), ['netflix'], 'no list falls back to configured apps');
  await V.refresh();
  equal(V.definitions().length, 3, 'first import selects all');
  reply = { available: true, apps: expected.concat({ appId: 'test.New', label: 'New' }) };
  await V.refresh();
  equal(V.definitions().length, 4, 'all-apps selection follows new arrivals');
  V.save(['test.Spotify']);
  await V.refresh(true);
  equal(V.definitions().map(d => d.label), ['Spotify'], 'explicit subset survives a refresh');
  reply = { available: false, apps: [] };
  await V.refresh();
  equal(V.definitions().map(d => d.label), ['Spotify'], 'an empty/unavailable list preserves usable saved apps');
  reply.error = { code: 'connection', detail: 'EACCES', message: 'connect EACCES 127.0.0.1:8099' };
  await V.refresh(true);
  equal(V.failureText(), 'Could not connect to Vetro', 'a connection error is not described as an empty list');
  assert.match(V.diagnostic(), /EACCES/); checks++;
  equal(V.definitions().map(d => d.label), ['Spotify'], 'diagnostics preserve the selected apps');
  reply = { available: true, apps: expected };
  await V.refresh(true);
  equal([V.error, V.diagnostic()], [null, ''], 'a successful refresh clears the error');
  V = client({ 'gh.vetro.v1': { entries: 'bad', selected: ['test.Bad'] } }, {}, () => Promise.resolve(reply));
  equal(V.definitions().map(d => d.key), ['netflix'], 'malformed stored list falls back');

  let response = JSON.stringify(catalog), status = 200, calls = [];
  const server = http.createServer((req, res) => {
    calls.push([req.method, req.url, req.headers.origin || null]);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8099, '127.0.0.1', resolve); });
  let svc;
  const temp = path.join(__dirname, 'tmp', 'vetro-test-' + process.pid);
  try {
    equal(await vetro.readApps('GlassHome1'), { available: true, apps: expected, address: '127.0.0.1' }, 'read real local HTTP response');
    equal(calls[0], ['GET', '/dock', null], 'fixed read-only request without browser Origin');
    const reader = vetro.createReader('GlassHome1');
    const before = calls.length;
    await Promise.all([reader(), reader()]);
    await reader();
    equal(calls.length - before, 1, 'coalesce concurrent reads and cache results');
    await reader(true);
    equal(calls.length - before, 2, 'explicit refresh bypasses the Glass Home read cache');
    response = 'not-json';
    await assert.rejects(vetro.readApps('GlassHome1'), e => e.vetro.code === 'json'); checks++;
    response = '{}';
    await assert.rejects(vetro.readApps('GlassHome1'), e => e.vetro.code === 'catalog'); checks++;
    response = '{"entries":[]}';
    const empty = await vetro.readApps('GlassHome1');
    equal([empty.available, empty.apps, empty.error.code], [false, [], 'empty'], 'empty list is distinct from a connection failure');
    response = ' '.repeat(300 * 1024);
    await assert.rejects(vetro.readApps('GlassHome1'), e => e.vetro.code === 'size'); checks++;
    status = 302;
    await assert.rejects(vetro.readApps('GlassHome1'), e => e.vetro.code === 'http' && e.vetro.status === 302); checks++;
    const errors = [];
    const failedReader = vetro.createReader('GlassHome1', e => errors.push(e));
    status = 503;
    const failure = await failedReader(true);
    equal([failure.available, failure.apps, failure.error.code, failure.error.status], [false, [], 'http', 503], 'reader preserves the HTTP error');
    await failedReader();
    equal(errors.length, 1, 'cached failure does not repeat diagnostic logging');
    status = 200;
    response = JSON.stringify(catalog);
    fs.mkdirSync(temp, { recursive: true });
    svc = require('../app/service/server.js').createService({
      appDir: path.join(root, 'app'), dataDir: temp, hosts: ['127.0.0.1'],
      port: 18393, config: { fetchIcons: false }, log: () => {}
    });
    await new Promise((resolve, reject) => svc.start(err => err ? reject(err) : resolve()));
    const endpoint = 'http://127.0.0.1:18393/local/vetro/apps';
    equal((await (await fetch('http://127.0.0.1:18393/health')).json()).vetroApps, 3, 'health identifies the running reader revision');
    const authBefore = calls.length;
    equal((await fetch(endpoint)).status, 403, 'unauthenticated caller cannot read catalog');
    equal(calls.length, authBefore, 'unauthenticated request does not contact Vetro');
    const url = endpoint + '?k=' + encodeURIComponent(svc.localKey());
    equal(await (await fetch(url)).json(), { available: true, apps: expected, address: '127.0.0.1' }, 'authenticated local channel returns catalog');
    const refreshBefore = calls.length;
    await fetch(url + '&refresh=1');
    equal(calls.length, refreshBefore + 1, 'refresh query causes another read from Vetro');
    status = 503;
    const apiFailure = await (await fetch(url + '&refresh=1')).json();
    equal(apiFailure.error.status, 503, 'local endpoint includes the underlying error');
    equal((await fetch(url, { method: 'POST' })).status, 404, 'no mutation endpoint');
  } finally {
    if (svc) await new Promise(resolve => svc.stop(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const missing = await vetro.createReader('GlassHome1')();
  equal([missing.available, missing.apps, missing.error.code, missing.error.detail], [false, [], 'connection', 'ECONNREFUSED'], 'missing Vetro reports the connection error');

  // A runtime may throw before a request exists, or while closing a failed
  // request. Both must settle the read and release its deadline timer.
  for (const scenario of ['setup', 'connection', 'timeout']) {
    const timers = new Set();
    let deadline;
    const exports = { exports: {} };
    const req = new EventEmitter();
    req.destroy = () => { throw new Error('close failed'); };
    req.end = () => {
      if (scenario === 'connection') req.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'app/service/vetro.js'), 'utf8'), {
      module: exports, Buffer,
      require: name => name === './netutil' ? { lanAddresses: () => [] } : ({ request: () => {
        if (scenario === 'setup') throw new TypeError('unsupported runtime option');
        return req;
      } }),
      setTimeout: fn => { deadline = fn; timers.add(fn); return fn; },
      clearTimeout: fn => timers.delete(fn)
    });
    const pending = exports.exports.createReader('GlassHome1')();
    if (scenario === 'timeout') deadline();
    const result = await pending;
    equal(result.error.code, { setup: 'request', connection: 'connection', timeout: 'timeout' }[scenario], scenario + ' failure is reported');
    if (scenario === 'connection') equal(result.error.detail, 'EACCES', 'socket error code is retained');
    equal(timers.size, 0, scenario + ' deadline is released');
  }

  const v4 = address => ({ address, internal: false, family: 'IPv4' });
  const interfaces = { eth0: [v4('192.168.84.19')], wlan0: [v4('10.1.2.3')] };
  for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM']) {
    const test = simulatedReader({ interfaces, responses: {
      '127.0.0.1': { error: code, elapsed: 1200 }, '192.168.84.19': {}
    } });
    equal(await test.reader.readApps('GlassHome1'), { available: true, apps: expected, address: '192.168.84.19' }, code + ' uses the same TV LAN address');
    equal(test.calls.map(c => [c.hostname, c.localAddress, c.port, c.path, c.method]), [
      ['127.0.0.1', '127.0.0.1', 8099, '/dock', 'GET'],
      ['192.168.84.19', '192.168.84.19', 8099, '/dock', 'GET']
    ], 'fixed read endpoint with source bound to each same-device destination');
    equal(test.durations, [25000, 23800], 'fallback shares the remaining deadline');
    equal(test.timers.size, 0, 'fallback releases timers');
  }
  for (const outcome of [{}, { status: 503 }, { status: 302 }, { body: 'invalid' }, { body: '{}' }, { body: '{"entries":[]}' }, { error: 'ECONNREFUSED' }]) {
    const test = simulatedReader({ interfaces, responses: { '127.0.0.1': outcome } });
    await test.reader.createReader('GlassHome1')();
    equal(test.calls.map(c => c.hostname), ['127.0.0.1'], 'successful responses, HTTP/data failures and absent Vetro do not trigger LAN attempts');
  }
  for (const outcome of [{ status: 302 }, { status: 503 }, { body: 'invalid' }]) {
    const test = simulatedReader({ interfaces, responses: {
      '127.0.0.1': { error: 'EHOSTUNREACH' }, '192.168.84.19': outcome, '10.1.2.3': {}
    } });
    const result = await test.reader.createReader('GlassHome1')();
    equal(result.error.code, outcome.status ? 'http' : 'json', 'LAN HTTP/data failure remains visible');
    equal(test.calls.length, 2, 'LAN response does not follow redirects or continue to another address');
  }
  const second = simulatedReader({ interfaces, responses: {
    '127.0.0.1': { error: 'EHOSTUNREACH' }, '192.168.84.19': { error: 'ECONNREFUSED' }, '10.1.2.3': {}
  } });
  equal((await second.reader.readApps('GlassHome1')).address, '10.1.2.3', 'a second assigned interface can provide the list');
  equal(second.calls.length, 3, 'stop after the first reachable LAN endpoint');
  const limited = simulatedReader({ interfaces: {
    eth0: [v4('192.168.84.19'), v4('192.168.84.19'), v4('8.8.8.8'), v4('169.254.1.2'), v4('bad.example'), v4('192.168.1.999')],
    lo: [{ address: '127.0.0.1', family: 4, internal: true }],
    wlan0: [v4('10.1.2.3'), v4('172.20.0.2'), v4('172.20.0.3'), { address: '::1', family: 'IPv6', internal: false }]
  }, responses: { '127.0.0.1': { error: 'EHOSTUNREACH' } } });
  const limitedResult = await limited.reader.createReader('GlassHome1')();
  equal(limited.calls.map(c => c.hostname), ['127.0.0.1', '192.168.84.19', '10.1.2.3', '172.20.0.2'], 'deduplicated assigned private IPv4 addresses only, at most three fallbacks');
  equal(limitedResult.error.attempted, limited.calls.map(c => c.hostname), 'failure reports every attempted same-device address');
  equal(limitedResult.error.address, '172.20.0.2', 'final error identifies the failing address');
  const noInterfaces = simulatedReader({ interfaceError: true, responses: { '127.0.0.1': { error: 'EHOSTUNREACH' } } });
  equal((await noInterfaces.reader.createReader('GlassHome1')()).error.detail, 'EHOSTUNREACH', 'interface discovery failure preserves the original connection error');
  equal(noInterfaces.calls.length, 1, 'no invented LAN address when interfaces cannot be read');
  const slow = simulatedReader({ interfaces, responses: { '127.0.0.1': { error: 'EHOSTUNREACH', elapsed: 24000 }, '192.168.84.19': { hang: true } } });
  const slowResult = slow.reader.createReader('GlassHome1')();
  await Promise.resolve();
  equal(slow.durations, [25000, 1000], 'a slow first attempt leaves only the remaining second');
  for (const fn of slow.timers.keys()) fn();
  equal((await slowResult).error.code, 'timeout', 'a hung LAN read respects the shared deadline');
  equal(slow.calls.length, 2, 'a timed-out read does not start another attempt');
  equal(slow.timers.size, 0, 'timed-out fallback cleans up its timer');
  const expired = simulatedReader({ interfaces, responses: { '127.0.0.1': { error: 'EHOSTUNREACH', elapsed: 25000 } } });
  equal((await expired.reader.createReader('GlassHome1')()).error.code, 'timeout', 'no fallback after the total deadline');
  equal(expired.calls.length, 1, 'expired budget does not open another socket');
  const changingOptions = { interfaces: { eth0: [v4('192.168.84.19')] }, responses: {
    '127.0.0.1': { error: 'EHOSTUNREACH' }, '192.168.84.19': {}, '10.1.2.3': {}
  } };
  const changing = simulatedReader(changingOptions), changingReader = changing.reader.createReader('GlassHome1');
  equal((await changingReader()).address, '192.168.84.19', 'initial discovery uses the current address');
  changingOptions.interfaces = { wlan0: [v4('10.1.2.3')] };
  await changingReader();
  equal(changing.calls.length, 2, 'cache avoids further probes');
  equal((await changingReader(true)).address, '10.1.2.3', 'refresh rediscovers assigned addresses after a network change');

  // Exercise an actual bound connection to this machine's private interface.
  // Only the initial denied localhost attempt is simulated.
  const own = require('../app/service/netutil.js').lanAddresses().find(e => /^(10\.|172\.|192\.168\.)/.test(e.address));
  if (!own) {
    console.log('SKIP real LAN socket check: this runtime cannot discover a private IPv4 interface');
  } else {
  let connection;
  const lanServer = http.createServer((req, res) => {
    connection = [req.socket.localAddress, req.socket.remoteAddress, req.url, req.headers['x-gh-key'] || null];
    res.end(JSON.stringify(catalog));
  });
  await new Promise((resolve, reject) => { lanServer.once('error', reject); lanServer.listen(8099, own.address, resolve); });
  try {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'app/service/vetro.js'), 'utf8'), {
      module, Buffer, setTimeout, clearTimeout,
      require: name => name === './netutil' ? require('../app/service/netutil.js') : {
        request: (options, cb) => {
          if (options.hostname !== '127.0.0.1') return http.request(options, cb);
          const req = new EventEmitter();
          req.destroy = () => {};
          req.end = () => req.emit('error', Object.assign(new Error('connect blocked'), { code: 'EHOSTUNREACH' }));
          return req;
        }
      }
    });
    equal(await module.exports.readApps('GlassHome1'), { available: true, apps: expected, address: own.address }, 'real LAN fallback returns the catalog');
    equal(connection, [own.address, own.address, '/dock', null], 'both real socket ends are on this host, with no local key forwarded');
  } finally {
    await new Promise(resolve => lanServer.close(resolve));
  }
  }
  console.log(checks + ' Vetro checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
