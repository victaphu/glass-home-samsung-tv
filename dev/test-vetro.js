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
    equal(await vetro.readApps('GlassHome1'), { available: true, apps: expected }, 'read real local HTTP response');
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
    equal((await (await fetch('http://127.0.0.1:18393/health')).json()).vetroApps, 2, 'health identifies the running reader revision');
    const authBefore = calls.length;
    equal((await fetch(endpoint)).status, 403, 'unauthenticated caller cannot read catalog');
    equal(calls.length, authBefore, 'unauthenticated request does not contact Vetro');
    const url = endpoint + '?k=' + encodeURIComponent(svc.localKey());
    equal(await (await fetch(url)).json(), { available: true, apps: expected }, 'authenticated local channel returns catalog');
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
      require: () => ({ request: () => {
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
  console.log(checks + ' Vetro checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
