#!/usr/bin/env node
// Vetro reader and saved selection: real loopback HTTP plus a TV-client VM.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
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
  await V.refresh();
  equal(V.enabled, false, 'discovering Vetro never enables it by default');
  equal(V.definitions().map(d => d.key), ['netflix'], 'configured list remains the default');
  V.save(true, ['test.Spotify', 'org.tizen.netflix-app']);
  equal(V.definitions().map(d => d.label), ['Netflix', 'Spotify'], 'Samsung order, independent of click order');
  equal(V.definitions()[0].storeId, '11101200001', 'known apps retain launch metadata');
  V = client(store, {}, () => Promise.reject(new Error('offline')));
  await V.refresh();
  equal(V.definitions().map(d => d.label), ['Netflix', 'Spotify'], 'selection and apps survive restart with Vetro offline');
  V.save(false, V.selected);
  equal(V.definitions().map(d => d.key), ['netflix'], 'disable restores configured apps');
  V.save(true, []);
  equal(V.definitions(), [], 'empty selection is intentional, not a fallback');
  store = {};
  V = client(store, { vetroApps: true }, () => Promise.resolve(reply));
  equal(V.definitions().map(d => d.key), ['netflix'], 'enabled with no list falls back to configured apps');
  await V.refresh();
  equal(V.definitions().length, 3, 'first enabled import selects all');
  reply = { available: true, apps: expected.concat({ appId: 'test.New', label: 'New' }) };
  await V.refresh();
  equal(V.definitions().length, 3, 'newly discovered apps require selection');
  reply = { available: false, apps: [] };
  await V.refresh();
  equal(V.definitions().length, 3, 'an empty/unavailable list preserves usable saved apps');
  V = client({ 'gh.vetro.v1': { entries: 'bad', selected: ['test.Bad'], enabled: true } }, {}, () => Promise.resolve(reply));
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
    response = 'not-json';
    await assert.rejects(vetro.readApps('GlassHome1')); checks++;
    response = ' '.repeat(300 * 1024);
    await assert.rejects(vetro.readApps('GlassHome1')); checks++;
    status = 302;
    await assert.rejects(vetro.readApps('GlassHome1')); checks++;
    status = 200;
    response = JSON.stringify(catalog);
    fs.mkdirSync(temp, { recursive: true });
    svc = require('../app/service/server.js').createService({
      appDir: path.join(root, 'app'), dataDir: temp, hosts: ['127.0.0.1'],
      port: 18393, config: { fetchIcons: false }, log: () => {}
    });
    await new Promise((resolve, reject) => svc.start(err => err ? reject(err) : resolve()));
    const endpoint = 'http://127.0.0.1:18393/local/vetro/apps';
    const authBefore = calls.length;
    equal((await fetch(endpoint)).status, 403, 'unauthenticated caller cannot read catalog');
    equal(calls.length, authBefore, 'unauthenticated request does not contact Vetro');
    const url = endpoint + '?k=' + encodeURIComponent(svc.localKey());
    equal(await (await fetch(url)).json(), { available: true, apps: expected }, 'authenticated local channel returns catalog');
    equal((await fetch(url, { method: 'POST' })).status, 404, 'no mutation endpoint');
  } finally {
    if (svc) await new Promise(resolve => svc.stop(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
  equal(await vetro.createReader('GlassHome1')(), { available: false, apps: [] }, 'missing Vetro is an optional unavailable source');
  console.log(checks + ' Vetro checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
