#!/usr/bin/env node
// Real service writes, forced service termination, and fresh TV-client realms
// with stale or unavailable browser storage. No live TV or Vetro is required.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const prefs = require('../app/service/dock-prefs.js');
const root = path.join(__dirname, '..');
const port = 18495;
const base = 'http://127.0.0.1:' + port;
const netflix = 'org.tizen.netflix-app';
const plus = 'com.samsung.tv.tvPlusDeeplinker';
const entries = [{ appId: netflix, label: 'Netflix' }, { appId: plus, label: 'Samsung TV Plus' }];
let checks = 0, child, key;
function equal(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
  checks++;
}
async function rejects(promise, message) { await assert.rejects(promise, undefined, message); checks++; }
fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(__dirname, 'tmp', 'dock-prefs-'));
const file = path.join(temp, 'dock-preferences.json');

async function start() {
  child = spawn(process.execPath, ['-e', `
    const s = require('./app/service/server.js').createService({
      appDir: ${JSON.stringify(path.join(root, 'app'))}, dataDir: ${JSON.stringify(temp)},
      port: ${port}, hosts: ['127.0.0.1'], config: { fetchIcons: false }, log: () => {}
    });
    s.start(e => { if (e) process.exit(1); else process.send({ key: s.localKey() }); });
  `], { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  key = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service startup timeout')), 15000);
    child.once('message', m => { clearTimeout(timer); resolve(m.key); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('service exited before ready')); });
  });
}
async function kill() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
  child = null;
}
async function call(method, body, authenticated = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (authenticated) headers['X-GH-Key'] = key;
  const res = await fetch(base + '/local/dock-preferences', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

// The real browser client uses HTTP here. Browser storage may fail every write
// or retain an older selection, as after an abruptly terminated UI process.
function client(stored, blocked) {
  const window = { GH_LOCAL_KEY: key, GH: { config: { serviceBase: base, apps: [] } } };
  const localStorage = {
    getItem: k => stored[k] || null,
    setItem: (k, value) => { if (blocked) throw new Error('storage unavailable'); stored[k] = value; },
    removeItem: k => { delete stored[k]; }
  };
  function XMLHttpRequest() { this.headers = {}; }
  XMLHttpRequest.prototype.open = function (method, url) { this.method = method; this.url = url; };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { this.headers[k] = v; };
  XMLHttpRequest.prototype.send = function (body) {
    fetch(this.url, { method: this.method, headers: this.headers, body: body === null ? undefined : body }).then(async r => {
      this.status = r.status; this.responseText = await r.text(); this.onload();
    }, () => this.onerror());
  };
  const context = vm.createContext({ window, localStorage, XMLHttpRequest });
  for (const name of ['data.js', 'vetro-apps.js']) vm.runInContext(fs.readFileSync(path.join(root, 'app/js', name), 'utf8'), context);
  return window.GH;
}
function cached(selected, hidden = []) {
  return { 'gh.vetro.v1': JSON.stringify({ entries, selected }), 'gh.hidden': JSON.stringify(hidden) };
}

(async () => {
  await start();
  equal((await (await fetch(base + '/health')).json()).dockPreferences, 1, 'runtime advertises confirmed preference storage');
  const preflight = await fetch(base + '/local/dock-preferences', {
    method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' }
  });
  equal([preflight.status, preflight.headers.get('access-control-allow-origin'), preflight.headers.get('access-control-allow-methods').includes('PUT')], [204, '*', true], 'packaged TV page can preflight its authenticated PUT');
  equal((await call('GET', undefined, false)).status, 403, 'read requires local key');
  equal((await call('PUT', { preferences: { selected: [], hidden: [] } }, false)).status, 403, 'write requires local key');
  equal((await call('GET')).data.preferences, null, 'no choices stored before first migration');

  let gh = client(cached([netflix], ['in:2']), false);
  await gh.vetro.loadPreferences();
  equal((await call('GET')).data.preferences, { selected: [netflix], hidden: ['in:2'] }, 'legacy choices migrate together');
  const init = await call('PUT', { initialize: true, preferences: { selected: null, hidden: [] } });
  equal(init.data.preferences, { selected: [netflix], hidden: ['in:2'] }, 'late initialization cannot reset saved choices');
  await gh.vetro.save([netflix, plus], ['in:2']);
  equal((await call('GET')).data.preferences, { selected: [netflix, plus], hidden: ['in:2'] }, 're-adding TV Plus is written before save resolves');
  equal(fs.statSync(file).mode & 511, 384, 'choice file is private');

  await kill(); // Deliberately no graceful close or exit-time flush.
  await start();
  gh = client(cached([netflix], ['vetro:' + plus]), true);
  gh.data.vetroApps = () => Promise.resolve({ available: false, apps: [] });
  await gh.vetro.refresh();
  equal(gh.vetro.definitions().map(e => e.label), ['Netflix', 'Samsung TV Plus'], 'force-stop restart restores re-added app despite stale unwritable browser cache and offline Vetro');
  equal(gh.vetro.hidden, ['in:2'], 'server hidden choices replace stale browser hiding');
  await gh.vetro.save(null, ['vetro:' + plus, 'in:2']);
  await kill();
  await start();
  gh = client(cached([netflix]), true);
  await gh.vetro.loadPreferences();
  equal([gh.vetro.selected, gh.vetro.hidden], [null, ['vetro:' + plus, 'in:2']], 'all-apps and hiding survive another forced stop');
  gh.data.vetroApps = () => Promise.resolve({ available: true, apps: entries.concat({ appId: 'test.New', label: 'New' }) });
  await gh.vetro.refresh(true);
  equal(gh.vetro.definitions().length, 3, 'all-apps follows new arrivals');
  equal(gh.vetro.hidden, ['vetro:' + plus, 'in:2'], 'refresh preserves hidden apps and inputs');
  await gh.vetro.save([], []);
  await kill();
  await start();
  gh = client(cached(null), false);
  await gh.vetro.loadPreferences();
  equal([gh.vetro.selected, gh.vetro.hidden, gh.vetro.definitions()], [[], [], []], 'empty selection and unhide survive restart');

  for (const bad of [{}, { selected: 'all', hidden: [] }, { selected: ['bad;id'], hidden: [] }, { selected: null, hidden: ['bad/path'] }, { selected: Array(101).fill(netflix), hidden: [] }]) {
    equal((await call('PUT', { preferences: bad })).status, 400, 'malformed preferences rejected');
  }
  equal((await call('PUT', { preferences: { selected: null, hidden: [] }, padding: 'x'.repeat(66000) })).status, 413, 'request is size limited');
  equal((await call('GET')).data.preferences, { selected: [], hidden: [] }, 'invalid writes preserve saved choices');

  // A real disk failure must fail the API and the client, leaving the last
  // confirmed choices intact. A retry can then succeed without a restart.
  fs.mkdirSync(file + '.tmp');
  equal((await call('PUT', { preferences: { selected: null, hidden: [] } })).status, 500, 'disk failure does not acknowledge save');
  await rejects(gh.vetro.save(null, []), 'client rejects failed save');
  equal([gh.vetro.selected, gh.vetro.saving], [[], false], 'failed save keeps confirmed choices and releases retry');
  equal((await call('GET')).data.preferences, { selected: [], hidden: [] }, 'previous choices survive failed atomic write');
  fs.rmdirSync(file + '.tmp');
  await gh.vetro.save(null, []);
  equal((await call('GET')).data.preferences, { selected: null, hidden: [] }, 'save succeeds on retry');

  // The UI's save promise cannot resolve before the service acknowledges it.
  const save = gh.data.saveDockPreferences;
  let finish;
  gh.data.saveDockPreferences = p => new Promise(resolve => { finish = () => resolve(p); });
  const pending = gh.vetro.save([netflix], ['in:2']);
  equal([gh.vetro.selected, gh.vetro.hidden, gh.vetro.saving], [null, [], true], 'pending save keeps confirmed state');
  await rejects(gh.vetro.save([], []), 'overlapping saves cannot race');
  finish(); await pending;
  equal([gh.vetro.selected, gh.vetro.hidden, gh.vetro.saving], [[netflix], ['in:2'], false], 'acknowledgment applies both settings together');
  gh.data.saveDockPreferences = save;

  // Corrupt storage is an error, not permission to overwrite user choices
  // with stale browser defaults. A failed restore remains retryable.
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{invalid');
  gh = client(cached([plus]), false);
  await rejects(gh.vetro.loadPreferences(), 'unreadable disk choices fail restoration');
  await rejects(gh.vetro.save([plus], []), 'save blocked until choices loaded');
  equal([gh.vetro.preferencesReady, gh.vetro.preferencesError], [false, true], 'restore failure is visible');
  equal(fs.readFileSync(file, 'utf8'), '{invalid', 'corrupt preferences are not silently replaced');
  fs.writeFileSync(file, good);
  await gh.vetro.loadPreferences();
  equal([gh.vetro.preferencesReady, gh.vetro.preferencesError, gh.vetro.selected], [true, false, null], 'restore retry uses disk choices');

  // fsync and read-back errors are tested without depending on a full disk.
  for (const stage of ['fsyncSync', 'renameSync', 'readFileSync']) {
    const fakeFs = Object.create(fs);
    fakeFs[stage] = () => { throw new Error('injected failure'); };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'app/service/dock-prefs.js'), 'utf8'), { module, require: () => fakeFs });
    assert.throws(() => module.exports.write(file, { selected: [plus], hidden: [] })); checks++;
  }
  equal(prefs.validate({ selected: [plus, plus], hidden: ['in:2', 'in:2'] }), { selected: [plus], hidden: ['in:2'] }, 'duplicate keys are normalized');
  console.log(checks + ' dock preference checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  await kill();
  fs.rmSync(temp, { recursive: true, force: true });
});
