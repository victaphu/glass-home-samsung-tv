#!/usr/bin/env node
// Unit tests for opening apps on a fake TV (app/js/platform.js): store IDs are
// tried in order through Samsung's launcher, with the normal launch as the
// fallback; and the store IDs in app/js/config.js.  Run: node dev/test-launch.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLATFORM = fs.readFileSync(path.join(ROOT, 'app', 'js', 'platform.js'), 'utf8');
const CONFIG = fs.readFileSync(path.join(ROOT, 'app', 'js', 'config.js'), 'utf8');

let checks = 0;
let fails = 0;
function eq(a, b, label) {
  checks++;
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) { fails++; console.log('FAIL ' + label + ': ' + A + ' !== ' + B); }
}

// A TV whose launcher answers each store ID with an HTTP status (404 when not
// listed), or 'down' when the launcher can't be reached.
function tv(answers) {
  const posts = [];
  const launches = [];
  function XHR() {}
  XHR.prototype.open = function (method, url) { this.method = method; this.url = url; };
  XHR.prototype.send = function () {
    const id = decodeURIComponent(this.url.split('/').pop());
    posts.push(this.method + ' ' + id);
    const a = answers[id] === undefined ? 404 : answers[id];
    setTimeout(() => { if (a === 'down') this.onerror(); else { this.status = a; this.onload(); } }, 1);
  };
  const tizen = {
    application: {
      launch(id, ok) { launches.push(id); setTimeout(ok, 1); },
      launchAppControl() { throw new Error('app control not expected'); }
    },
    ApplicationControl: function () {}
  };
  const window = { GH: { config: { preview: false } }, tizen };
  vm.runInNewContext(PLATFORM, { window, XMLHttpRequest: XHR, setTimeout, clearTimeout });
  return { P: window.GH.platform, posts, launches };
}

const NETFLIX = ['3201907018807', '11101200001'];

(async () => {
  let t = tv({ '3201907018807': 200 });
  eq(await t.P.launchApp('org.tizen.netflix-app', NETFLIX), 'smarthub', 'newer TV: first store ID opens the app');
  eq(t.posts, ['POST 3201907018807'], 'newer TV: only the first ID is tried');
  eq(t.launches, [], 'newer TV: no normal launch');

  t = tv({ '11101200001': 200 });
  eq(await t.P.launchApp('RN1MCdNq8t.Netflix', NETFLIX), 'smarthub', 'older TV: second store ID opens the app after a 404');
  eq(t.posts, ['POST 3201907018807', 'POST 11101200001'], 'older TV: IDs tried in order');
  eq(t.launches, [], 'older TV: no normal launch');

  t = tv({});
  eq(await t.P.launchApp('org.tizen.netflix-app', NETFLIX), 'launch', 'no ID known: normal launch');
  eq(t.posts, ['POST 3201907018807', 'POST 11101200001'], 'no ID known: both tried first');
  eq(t.launches, ['org.tizen.netflix-app'], 'no ID known: then the normal launch');

  t = tv({ '3201907018807': 'down' });
  eq(await t.P.launchApp('org.tizen.netflix-app', NETFLIX), 'launch', 'launcher unreachable: normal launch');
  eq(t.posts, ['POST 3201907018807'], 'launcher unreachable: no further IDs tried');

  t = tv({ '111299001912': 200 });
  eq(await t.P.launchApp('9Ur5IzDKqV.TizenYouTube', '111299001912'), 'smarthub', 'a single store ID still works');

  t = tv({ '111299001912': 200 });
  eq(await t.P.launchApp('9Ur5IzDKqV.TizenYouTube', null), 'launch', 'smartHubLaunch off (no store ID): normal launch');
  eq(t.posts, [], 'smartHubLaunch off: the launcher is not asked');

  // config.js: smartHubLaunch is off by default, and store IDs are numbers,
  // with the newer Netflix and Prime Video IDs first.
  const win = {};
  vm.runInNewContext(CONFIG, { window: win, location: { search: '' } });
  const cfg = win.GH.config;
  const byKey = {};
  cfg.apps.forEach((a) => { byKey[a.key] = a; });
  eq(cfg.smartHubLaunch, false, 'config: smartHubLaunch off by default');
  eq(byKey.netflix.storeId, NETFLIX, 'config: Netflix store IDs, newer first');
  eq(byKey.prime.storeId, ['3201910019365', '3201512006785'], 'config: Prime Video store IDs, newer first');
  eq(cfg.apps.every((a) => a.storeId === undefined || [].concat(a.storeId).every((s) => /^\d{9,15}$/.test(s))), true, 'config: every store ID is a number');

  console.log(checks + ' checks, ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
