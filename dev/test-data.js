#!/usr/bin/env node
// Unit tests for the TV app's service client, app/js/data.js (no browser: the
// page globals are stubbed and a fake service answers the XHRs). Checks that
// the website password is never written to localStorage, that a copy left by
// an older build is removed at start, and what the + panel shows when the
// service is up, down, or restarted.
//   node dev/test-data.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'data.js'), 'utf8');
let fails = 0;
let count = 0;
function eq(label, got, want) {
  count++;
  if (JSON.stringify(got) !== JSON.stringify(want)) { fails++; console.log('FAIL ' + label + ': ' + JSON.stringify(got) + ' != ' + JSON.stringify(want)); }
}
function ok(label, cond, detail) { eq(label + (cond ? '' : ' ' + JSON.stringify(detail)), !!cond, true); }

const PW = 'maple-otter-sky-47';

// A fake photo service: svc.up, svc.rev and svc.pw ({ id, generated, plain })
// are changed by the tests; plain is null after a "restart".
function fakeService() {
  const svc = { up: true, rev: 7, pw: { id: 'p1', generated: true, plain: PW }, made: 0 };
  svc.handle = (method, url) => {
    if (!svc.up) return null;
    if (method === 'GET' && url.indexOf('/local/state') >= 0) {
      const m = /[?&]rev=(\d+)/.exec(url);
      const extra = { service: { node: 'v16.17.1' }, lan: { url: 'http://192.168.1.9:8090' } };
      if (m && Number(m[1]) === svc.rev) return { status: 200, body: Object.assign({ rev: svc.rev, same: true }, extra) };
      return { status: 200, body: Object.assign({ rev: svc.rev, password: Object.assign({}, svc.pw), photos: [], shortcuts: [], limits: {} }, extra) };
    }
    if (method === 'POST' && url.indexOf('/local/password') >= 0) {
      svc.made += 1;
      svc.pw = { id: 'n' + svc.made, generated: true, plain: 'new-pass-word-' + (10 + svc.made) };
      svc.rev += 1;
      return { status: 200, body: { id: svc.pw.id, plain: svc.pw.plain } };
    }
    return { status: 404, body: { error: 'not-found' } };
  };
  return svc;
}

// Loads data.js as the TV app does, with `stored` already in localStorage.
function boot(stored, svc) {
  const store = Object.assign({}, stored);
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const urls = [];
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function (method, url) { this.method = method; this.url = url; };
  XMLHttpRequest.prototype.setRequestHeader = function () {};
  XMLHttpRequest.prototype.send = function () {
    const x = this;
    urls.push(x.method + ' ' + x.url.replace(/[?&]k=[^&]*/, ''));
    const r = svc.handle(x.method, x.url);
    setTimeout(() => {
      if (!r) { x.onerror(); return; }
      x.status = r.status;
      x.responseText = JSON.stringify(r.body);
      x.onload();
    }, 0);
  };
  const window = { GH: { config: { serviceBase: 'http://127.0.0.1:8090' } }, GH_LOCAL_KEY: 'test-key' };
  vm.runInContext(src, vm.createContext({ window, localStorage, XMLHttpRequest, setTimeout, clearTimeout }));
  return { D: window.GH.data, store, urls };
}
const noPlainStored = (store, plain) => Object.keys(store).every((k) => String(store[k]).indexOf(plain) < 0);

(async () => {
  const oldState = { rev: 7, password: { id: 'p1', generated: true, plain: null }, photos: [], shortcuts: [], lan: { url: 'http://192.168.1.9:8090' } };
  const olderBuild = { 'gh.pw.v1': JSON.stringify({ id: 'p1', plain: PW }), 'gh.state.v1': JSON.stringify(oldState), 'gh.focus': '"app:youtube"' };

  { // Start-up with what an older build left behind.
    const svc = fakeService();
    svc.up = false;
    const t = boot(olderBuild, svc);
    eq('old stored password removed at start', t.store['gh.pw.v1'], undefined);
    eq('other stored settings kept', [!!t.store['gh.state.v1'], t.store['gh.focus']], [true, '"app:youtube"']);
    let v = t.D.passwordView();
    ok('before the first check: no password, "starting" note', v.text === null && /starting/.test(v.note), v);
    const r = await t.D.refresh();
    v = t.D.passwordView();
    ok('service down: no password shown, "starting" note', !r.online && v.text === null && /starting/.test(v.note), v);
    ok('service down: nothing stored holds the password', noPlainStored(t.store, PW), t.store);

    svc.up = true;                              // the service comes up
    const r2 = await t.D.refresh();
    eq('first state request of a run is a full one (no ?rev=)', t.urls[t.urls.length - 1], 'GET http://127.0.0.1:8090/local/state');
    eq('service up: the password is shown', [r2.online, t.D.passwordView()], [true, { text: PW, note: '' }]);
    ok('service up: still nothing stored holds the password', noPlainStored(t.store, PW), t.store);
    eq('stored state keeps the password id only', JSON.parse(t.store['gh.state.v1']).password, { id: 'p1', generated: true, plain: null });
    await t.D.refresh();
    eq('later requests send ?rev=', t.urls[t.urls.length - 1], 'GET http://127.0.0.1:8090/local/state?rev=7');
    eq('unchanged state: still shown', t.D.passwordView().text, PW);

    svc.pw.plain = null;                        // the service restarts (plain password gone), state unchanged
    await t.D.refresh();
    eq('service restarted while the app runs: still shown from memory', t.D.passwordView().text, PW);
    svc.rev += 1;                               // ...and a photo is added, so a full state comes
    await t.D.refresh();
    eq('full state after the restart: still shown from memory', t.D.passwordView().text, PW);

    svc.up = false;
    await t.D.refresh();
    ok('service down again: "starting" note instead of the password', t.D.passwordView().text === null && /starting/.test(t.D.passwordView().note), t.D.passwordView());
    svc.up = true;
    await t.D.refresh();
    eq('and back up: shown again', t.D.passwordView().text, PW);

    const made = await t.D.newPassword();
    eq('New password: the new one is shown', t.D.passwordView(), { text: made, note: '' });
    await t.D.refresh();
    eq('after New password: full refresh, still the new one', [t.urls[t.urls.length - 1], t.D.passwordView().text], ['GET http://127.0.0.1:8090/local/state', made]);
    ok('New password: nothing stored holds it', noPlainStored(t.store, made) && noPlainStored(t.store, PW), t.store);
  }

  { // The service cannot show the password (one made before shown.json existed).
    const svc = fakeService();
    svc.pw.plain = null;
    const t = boot({ 'gh.state.v1': JSON.stringify(oldState) }, svc);
    await t.D.refresh();
    const v = t.D.passwordView();
    ok('TV-made password the service cannot show: not shown, note says so', v.text === null && /before an update/.test(v.note) && /New password/.test(v.note), v);
    svc.pw = { id: 'p9', generated: false, plain: null };
    svc.rev += 1;
    await t.D.refresh();
    const w = t.D.passwordView();
    ok('password set on a phone, after a restart: "changed on a phone" note', w.text === null && /phone/.test(w.note), w);
    svc.pw = { id: 'p10', generated: false, plain: 'blue harbour lights' };
    svc.rev += 1;
    await t.D.refresh();
    eq('password changed on a phone while running: shown', t.D.passwordView().text, 'blue harbour lights');
  }

  { // First install: no stored state, the TV makes a password before any refresh.
    const svc = fakeService();
    const t = boot({}, svc);
    const made = await t.D.newPassword();
    eq('New password before the first refresh: shown', t.D.passwordView().text, made);
  }

  { // Preserve the app-service failure without copying its private request URL.
    const svc = fakeService();
    const t = boot({}, svc);
    for (const up of [true, false]) {
      svc.up = up;
      let error;
      try { await t.D.vetroApps(true); } catch (e) { error = e; }
      eq('Vetro service failure detail', error && error.vetro.detail, up ? 'HTTP 404' : 'unreachable');
      ok('Vetro diagnostic excludes the local key', error && JSON.stringify(error.vetro).indexOf('test-key') < 0);
    }
  }

  console.log(count + ' checks, ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

