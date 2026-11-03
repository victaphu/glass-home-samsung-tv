#!/usr/bin/env node
// Real TV page and photo service, with a local fake Vetro catalog.
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { launch, sleep } = require('./cdp.js');
const ROOT = path.join(__dirname, '..');
const K = { UP: 38, DOWN: 40, RIGHT: 39, ENTER: 13, BACK: 27 };
let checks = 0;
function check(value, message) { assert(value, message); checks++; }

(async () => {
  let requests = 0, responseStatus = 200;
  const vetro = http.createServer((req, res) => {
    requests++;
    assert.strictEqual(req.method, 'GET');
    assert.strictEqual(req.url, '/dock');
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries: [
      { slug: 'netflix', appId: 'org.tizen.netflix-app', label: 'Netflix' },
      { slug: 'spotify', appId: 'test.Spotify', label: 'Spotify' },
      { slug: 'tvplus', appId: 'org.tizen.tv-viewer', label: 'Samsung TV Plus' },
      { slug: 'home', appId: 'sys:com.samsung.tv.csfs', label: 'Samsung Home', system: true },
      { slug: 'glass', appId: 'GlassHome1.GlassHome', label: 'Glass Home' }
    ] }));
  });
  await new Promise((resolve, reject) => { vetro.once('error', reject); vetro.listen(8099, '127.0.0.1', resolve); });
  let runner, browser;
  try {
    runner = spawn(process.execPath, [path.join(__dirname, 'run.js'), '--quiet', '--no-fetch', '--port', '18490', '--ui-port', '18491'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('runner timeout')), 20000);
      runner.on('message', m => { if (m.ready) { clearTimeout(t); resolve(); } });
      runner.on('exit', () => { clearTimeout(t); reject(new Error('runner exited')); });
    });
    browser = await launch();
    const tv = await browser.newPage({ width: 1920, height: 1080 });
    const base = 'http://127.0.0.1:18491/index.html?preview=1&api=http://127.0.0.1:18490&still=1';
    await tv.goto(base + '&panel=1', 1800);
    async function choose(selector, label, direction) {
      for (let i = 0; i < 105; i++) {
        const focused = await tv.eval(`document.querySelector(${JSON.stringify(selector + '.focused')})?.textContent`);
        if (focused && focused.replace('✓', '').trim() === label) { await tv.key(K.ENTER); await sleep(150); return; }
        await tv.key(direction);
      }
      throw new Error('Could not focus ' + label);
    }
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 3"), 'Vetro apps appear automatically on load');
    check(await tv.eval("document.querySelector('#panel-app-buttons').getBoundingClientRect().top > document.querySelector('#panel-buttons').getBoundingClientRect().bottom"), 'app controls sit below New password / Done');
    async function openPicker() {
      await tv.key(K.DOWN);
      await choose('#panel-app-buttons .pbtn', 'Choose apps', K.RIGHT);
    }
    await openPicker();
    check(await tv.eval("document.querySelector('#vetro-picker').classList.contains('open')"), 'remote opens picker');
    check(await tv.eval("![...document.querySelectorAll('.vetro-label')].some(e => e.textContent === 'Use Vetro apps')"), 'picker has no enable toggle');
    check(await tv.eval("[...document.querySelectorAll('.vetro-label')].some(e => e.textContent === 'Spotify')"), 'unknown configured apps can be selected');
    check(await tv.eval("![...document.querySelectorAll('.vetro-label')].some(e => /Samsung Home|Glass Home/.test(e.textContent))"), 'controls and self omitted');
    fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true });
    await tv.shot(path.join(ROOT, 'preview/tv-vetro-picker.png'));
    await choose('.vetro-option', 'Select all', K.DOWN);
    await choose('.vetro-option', 'Save', K.DOWN);
    await tv.key(K.BACK);
    await sleep(300);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 3"), 'Select all adds every app');
    await tv.eval("window.testLaunch = null; const launch = GH.platform.launchApp; GH.platform.launchApp = function(id, storeId) { window.testLaunch = id; return launch(id, storeId); };");
    await tv.key(K.ENTER);
    check(await tv.eval("window.testLaunch === 'org.tizen.netflix-app'"), 'selected app uses its launch ID');
    await tv.goto(base + '&panel=1', 1800);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 3"), 'selection survives reload');
    await openPicker();
    await choose('.vetro-option', 'Clear selection', K.DOWN);
    await tv.key(K.BACK);
    await tv.key(K.BACK);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 3"), 'Back cancels draft changes');
    await tv.goto(base + '&panel=1', 1500);
    await openPicker();
    await choose('.vetro-option', 'Spotify', K.DOWN);
    await choose('.vetro-option', 'Save', K.DOWN);
    await tv.key(K.BACK);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 'individual checkbox removes one app');
    await tv.goto(base + '&panel=1', 1500);
    await tv.key(K.DOWN);
    const before = requests;
    await choose('#panel-app-buttons .pbtn', 'Refresh apps', K.RIGHT);
    await sleep(300);
    check(requests > before, 'Refresh apps performs a new read without waiting for the cache');
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 'refresh preserves the custom app selection');
    responseStatus = 503;
    await choose('#panel-app-buttons .pbtn', 'Refresh apps', K.RIGHT);
    await sleep(300);
    check(await tv.eval("document.querySelector('#panel-app-status').textContent.includes('HTTP 503')"), 'failed refresh shows the HTTP failure');
    check(await tv.eval("document.querySelector('.vetro-error').textContent.includes('HTTP 503')"), 'diagnostic includes the underlying error');
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 'failed refresh retains selected apps');
    check(await tv.eval("(() => { const r=document.querySelector('#panel').getBoundingClientRect(); return r.top >= 0 && r.bottom <= 1080; })()"), 'error diagnostic fits on screen');
    responseStatus = 200;
    await choose('#panel-app-buttons .pbtn', 'Refresh apps', K.RIGHT);
    await sleep(300);
    check(await tv.eval("!document.querySelector('.vetro-error')"), 'recovery clears the diagnostic');

    await tv.goto(base + '&panel=1', 1500);
    await openPicker();
    await choose('.vetro-option', 'Samsung TV Plus', K.DOWN);
    await choose('.vetro-option', 'Save', K.DOWN);
    check(await tv.eval("document.querySelector('#toast').textContent === 'App selection saved'"), 'save confirmation follows successful storage');
    await tv.goto(base + '&panel=1', 1500);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 1"), 'removing TV Plus persists');
    await openPicker();
    await choose('.vetro-option', 'Samsung TV Plus', K.DOWN);
    await choose('.vetro-option', 'Save', K.DOWN);
    await tv.eval("const stale = JSON.parse(localStorage.getItem('gh.vetro.v1')); stale.selected = ['org.tizen.netflix-app']; localStorage.setItem('gh.vetro.v1', JSON.stringify(stale)); localStorage.setItem('gh.hidden', JSON.stringify(['vetro:com.samsung.tv.tvPlusDeeplinker']));");
    await tv.goto(base + '&panel=1', 1500);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 're-added TV Plus returns despite stale browser selection and hiding');
    check(await tv.eval("GH.vetro.hidden.length === 0"), 'restoration uses the confirmed hidden choices');

    await openPicker();
    await choose('.vetro-option', 'Samsung TV Plus', K.DOWN);
    await tv.eval("window.originalSave = GH.data.saveDockPreferences; GH.data.saveDockPreferences = function () { return Promise.reject(new Error('test write failure')); };");
    await choose('.vetro-option', 'Save', K.DOWN);
    check(await tv.eval("document.querySelector('#vetro-picker').classList.contains('open')"), 'failed save leaves picker open');
    check(await tv.eval("document.querySelector('#toast').textContent.includes('Couldn’t save app selection')"), 'failed save reports failure instead of saved');
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 'failed save keeps the confirmed dock');
    await tv.eval("GH.data.saveDockPreferences = window.originalSave;");
    await choose('.vetro-option', 'Save', K.DOWN);
    check(await tv.eval("!document.querySelector('#vetro-picker').classList.contains('open')"), 'successful retry closes picker');
    await tv.key(K.BACK);
    await tv.key(K.ENTER, { hold: 850 });
    await choose('.menu-item', 'Hide', K.DOWN);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 0"), 'Hide waits for confirmed settings');
    await tv.goto(base + '&panel=1', 1500);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 0"), 'hidden app stays hidden after restart');
    await tv.key(K.DOWN);
    await choose('#panel-app-buttons .pbtn', 'Refresh apps', K.RIGHT);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 0"), 'refresh preserves hidden app');
    await tv.goto(base + '&panel=1', 1500);
    await choose('#panel-buttons .pbtn', 'Show hidden apps (1)', K.RIGHT);
    await tv.goto(base + '&panel=1', 1500);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 1"), 'unhide persists across restart');
    console.log(checks + ' Vetro browser checks passed');
  } finally {
    if (browser) await browser.close();
    if (runner) runner.kill();
    await new Promise(resolve => vetro.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
