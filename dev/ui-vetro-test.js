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
  let requests = 0;
  const vetro = http.createServer((req, res) => {
    requests++;
    assert.strictEqual(req.method, 'GET');
    assert.strictEqual(req.url, '/dock');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries: [
      { slug: 'netflix', appId: 'org.tizen.netflix-app', label: 'Netflix' },
      { slug: 'spotify', appId: 'test.Spotify', label: 'Spotify' },
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
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 'Vetro apps appear automatically on load');
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
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 'Select all adds both apps');
    await tv.eval("window.testLaunch = null; const launch = GH.platform.launchApp; GH.platform.launchApp = function(id, storeId) { window.testLaunch = id; return launch(id, storeId); };");
    await tv.key(K.ENTER);
    check(await tv.eval("window.testLaunch === 'org.tizen.netflix-app'"), 'selected app uses its launch ID');
    await tv.goto(base + '&panel=1', 1800);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 'selection survives reload');
    await openPicker();
    await choose('.vetro-option', 'Clear selection', K.DOWN);
    await tv.key(K.BACK);
    await tv.key(K.BACK);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 2"), 'Back cancels draft changes');
    await tv.goto(base + '&panel=1', 1500);
    await openPicker();
    await choose('.vetro-option', 'Spotify', K.DOWN);
    await choose('.vetro-option', 'Save', K.DOWN);
    await tv.key(K.BACK);
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 1"), 'individual checkbox removes one app');
    await tv.goto(base + '&panel=1', 1500);
    await tv.key(K.DOWN);
    const before = requests;
    await choose('#panel-app-buttons .pbtn', 'Refresh apps', K.RIGHT);
    await sleep(300);
    check(requests > before, 'Refresh apps performs a new read without waiting for the cache');
    check(await tv.eval("document.querySelectorAll('#dock-row .tile-app').length === 1"), 'refresh preserves the custom app selection');
    console.log(checks + ' Vetro browser checks passed');
  } finally {
    if (browser) await browser.close();
    if (runner) runner.kill();
    await new Promise(resolve => vetro.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
