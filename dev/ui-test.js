#!/usr/bin/env node
// Glass Home - UI test and screenshots (Mac only, Node 22, headless Brave).
//
// Starts its own dev runner with demo content on 127.0.0.1, drives the TV app
// with remote-style key presses (including a held OK) and the phone website
// with taps, checks what happens, and writes screenshots to ../preview/.
//
//   node dev/ui-test.js            checks + screenshots
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'preview');
const PORT = 18290;
const UI = 18291;
const K = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 27 };

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); }
}

function startRunner() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'run.js'), '--demo', '--quiet', '--port', String(PORT), '--ui-port', String(UI)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const t = setTimeout(() => reject(new Error('runner did not start')), 60000);
    child.on('message', (m) => { if (m && m.ready) { clearTimeout(t); resolve(child); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('runner exited ' + c)); });
  });
}

async function tvState(p) {
  return p.eval(`(() => {
    const tiles = [...document.querySelectorAll('#dock-row .tile')];
    const f = document.querySelector('#dock-row .tile.focused');
    return {
      count: tiles.length,
      focus: tiles.indexOf(f),
      label: document.getElementById('label').textContent,
      menuOpen: document.getElementById('menu').classList.contains('open'),
      menuItems: [...document.querySelectorAll('#menu .menu-item')].map(e => e.textContent + (e.classList.contains('focused') ? '*' : '') + (e.classList.contains('disabled') ? '(x)' : '')),
      panelOpen: document.getElementById('panel').classList.contains('open'),
      toast: document.getElementById('toast').classList.contains('on') ? document.getElementById('toast').textContent : '',
      labels: tiles.map(t => t.className)
    };
  })()`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const runner = await startRunner();
  const browser = await launch();
  try {
    // ---------------- TV app ----------------
    console.log('TV app');
    const tv = await browser.newPage({ width: 1920, height: 1080 });
    const base = 'http://127.0.0.1:' + UI + '/index.html?preview=1&api=' + encodeURIComponent('http://127.0.0.1:' + PORT);
    await tv.goto(base + '&bg=nature-06.jpg', 4500);
    let s = await tvState(tv);
    check('dock has 6 apps + 3 shortcuts + "+"', s.count === 10, s.count);
    check('first tile (YouTube) focused at start', s.focus === 0 && s.label === 'YouTube', s);
    const order = await tv.eval(`[...document.querySelectorAll('#dock-row .tile')].map((t, i) => t.className.replace('tile tile-', '').split(' ')[0])`);
    check('apps first, then shortcuts, then +', JSON.stringify(order) === JSON.stringify(['app', 'app', 'app', 'app', 'app', 'app', 'web', 'web', 'youtube', 'add']), order);
    await tv.shot(path.join(OUT, 'tv-home.png'));

    await tv.key(K.LEFT);
    s = await tvState(tv);
    check('Left at the first tile does not wrap', s.focus === 0, s.focus);
    for (let i = 0; i < 6; i++) await tv.key(K.RIGHT);
    s = await tvState(tv);
    check('Right x6 focuses the first shortcut (Wikipedia)', s.focus === 6 && s.label === 'Wikipedia', s);
    await sleep(500);
    await tv.shot(path.join(OUT, 'tv-focus.png'));

    await tv.key(K.ENTER, { hold: 900 });
    s = await tvState(tv);
    check('holding OK for 0.9 s opens the menu', s.menuOpen, s);
    check('menu: Move left disabled, Move right focused, Remove, Cancel', JSON.stringify(s.menuItems) === JSON.stringify(['Move left(x)', 'Move right*', 'Remove', 'Cancel']), s.menuItems);
    await sleep(300);
    await tv.shot(path.join(OUT, 'tv-menu.png'));
    await tv.key(K.BACK);
    s = await tvState(tv);
    check('Back closes the menu', !s.menuOpen, s);

    // Move right through the menu, then check the service saved the order.
    await tv.key(K.ENTER, { hold: 900 });
    await tv.key(K.ENTER);                 // "Move right" is focused
    await sleep(600);
    s = await tvState(tv);
    check('Move right keeps focus on the moved tile', s.label === 'Wikipedia' && s.focus === 7, s);
    const scOrder = await tv.eval(`fetch('http://127.0.0.1:${PORT}/local/state?k=' + encodeURIComponent(window.GH_LOCAL_KEY)).then(r => r.json()).then(d => d.shortcuts.map(x => x.name))`);
    check('new shortcut order saved in the service', scOrder[0] === 'Map' && scOrder[1] === 'Wikipedia', scOrder);
    await tv.key(K.ENTER, { hold: 900 });
    await tv.key(K.ENTER);                 // Move left is now the first enabled item
    await sleep(600);
    s = await tvState(tv);
    check('Move left puts it back', s.label === 'Wikipedia' && s.focus === 6, s);

    // Short press on an app: preview shows what would open.
    await tv.key(K.LEFT);
    await tv.key(K.ENTER);
    await sleep(400);
    s = await tvState(tv);
    check('OK on Internet opens it (preview toast)', /would open Internet/.test(s.toast), s.toast);

    // Hide an app, then bring it back from the + panel.
    await tv.key(K.ENTER, { hold: 900 });
    s = await tvState(tv);
    check('app menu offers Hide', s.menuItems.indexOf('Hide') >= 0, s.menuItems);
    await tv.key(K.DOWN);                  // Move left -> Hide
    const beforeHide = await tvState(tv);
    await tv.key(K.ENTER);
    await sleep(400);
    s = await tvState(tv);
    check('Hide removes the app from the dock', s.count === 9, { count: s.count, before: beforeHide.menuItems, open: beforeHide.menuOpen, label: beforeHide.label });

    // Go to the + tile (last) and open the panel.
    for (let i = 0; i < 10; i++) await tv.key(K.RIGHT);
    s = await tvState(tv);
    check('Right at the last tile stops on +', s.label === 'Add photos and shortcuts', s.label);
    await tv.key(K.ENTER);
    await sleep(900);
    s = await tvState(tv);
    check('OK on + opens the panel', s.panelOpen, s);
    const panel = await tv.eval(`({ url: document.getElementById('panel-url').textContent, pw: document.getElementById('panel-pw').textContent, stats: document.getElementById('panel-stats').textContent, buttons: [...document.querySelectorAll('#panel .pbtn')].map(b => b.textContent) })`);
    check('panel shows the address', /^http:\/\/127\.0\.0\.1:18290$/.test(panel.url), panel.url);
    check('panel shows a generated password', /^[a-z]+-[a-z]+-[a-z]+-\d\d$/.test(panel.pw), panel.pw);
    check('panel offers Show hidden apps (1)', panel.buttons.indexOf('Show hidden apps (1)') >= 0, panel.buttons);
    await tv.key(K.RIGHT);
    await tv.key(K.ENTER);                 // Show hidden apps
    await sleep(400);
    s = await tvState(tv);
    check('hidden app restored', s.count === 10, s.count);
    await tv.key(K.LEFT);
    await sleep(300);
    await tv.shot(path.join(OUT, 'tv-panel.png'));

    // New password from the TV: two presses, and the panel shows the new one.
    const before = panel.pw;
    await tv.key(K.ENTER);
    const armed = await tv.eval(`document.querySelector('#panel .pbtn.focused').textContent`);
    check('New password asks for a second OK', /again/.test(armed), armed);
    await tv.key(K.ENTER);
    await sleep(1200);
    const after = await tv.eval(`document.getElementById('panel-pw').textContent`);
    check('New password shows a different password', after !== before && /^[a-z]+-[a-z]+-[a-z]+-\d\d$/.test(after), [before, after]);
    const stored = await tv.eval(`Object.keys(localStorage).filter((k) => [${JSON.stringify(before)}, ${JSON.stringify(after)}].some((pw) => (localStorage.getItem(k) || '').indexOf(pw) >= 0))`);
    check('the password is not written to localStorage', stored.length === 0, stored);
    // YouTube link mode switch (bottom row)
    await tv.key(K.DOWN);
    await tv.key(K.ENTER);
    const ytm = await tv.eval(`document.querySelector('#panel .pbtn.small').textContent`);
    check('YouTube link mode switch cycles', /payload \+ URL/.test(ytm), ytm);
    await tv.key(K.ENTER);
    await tv.key(K.ENTER);                 // back to watch URL (the default)
    await tv.key(K.BACK);
    await sleep(400);
    s = await tvState(tv);
    check('Back closes the panel', !s.panelOpen, s);
    await tv.key(K.BACK);
    s = await tvState(tv);
    check('Back at the top level does nothing', !s.panelOpen && !s.menuOpen && s.count === 10, s);

    // Visibility: hidden pauses the clock timer and photo rotation.
    const vis = await tv.eval(`(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      const paused = document.documentElement.classList.contains('paused');
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      return { paused, resumed: !document.documentElement.classList.contains('paused') };
    })()`);
    check('hidden -> paused, visible -> resumed', vis.paused && vis.resumed, vis);

    const tvErrors = tv.errors.filter((e) => !/favicon\.ico/.test(e));
    check('no script errors in the TV app', tvErrors.length === 0, tvErrors);

    // An older build kept the password in localStorage: the next start removes it.
    await tv.eval(`localStorage.setItem('gh.pw.v1', JSON.stringify({ id: 'old', plain: ${JSON.stringify(after)} }))`);

    // Second look: another photo, a shortcut focused, still frame.
    const tv2 = await browser.newPage({ width: 1920, height: 1080 });
    await tv2.goto(base + '&bg=nature-11.jpg&focus=8', 4500);
    check('a password stored by an older build is removed at start', (await tv2.eval(`localStorage.getItem('gh.pw.v1')`)) === null);
    await sleep(400);
    await tv2.shot(path.join(OUT, 'tv-focus-youtube.png'));
    await tv2.close();

    // Service not running: + says the website is starting and shows no password.
    const tvDown = await browser.newPage({ width: 1920, height: 1080 });
    await tvDown.goto('http://127.0.0.1:' + UI + '/index.html?preview=1&still=1&panel=1&api=' + encodeURIComponent('http://127.0.0.1:' + (PORT + 9)), 3500);
    const down = await tvDown.eval(`({ open: document.getElementById('panel').classList.contains('open'), pw: document.getElementById('panel-pw').textContent, note: document.getElementById('panel-pw-note').textContent })`);
    check('service down: + shows no password and says the website is starting', down.open && down.pw === '—' && /starting/.test(down.note), down);
    await tvDown.close();

    // Older-TV switches: smartHubLaunch is off by default; photoService: false
    // (here ?photoService=0) leaves only the apps, and nothing can be hidden.
    const tvOld = await browser.newPage({ width: 1920, height: 1080 });
    await tvOld.goto(base + '&still=1&photoService=0', 4500);
    check('smartHubLaunch is off by default', (await tvOld.eval('GH.config.smartHubLaunch')) === false);
    s = await tvState(tvOld);
    check('no photo service: only the 6 apps, no shortcuts or +', s.count === 6, s);
    for (let i = 0; i < 10; i++) await tvOld.key(K.RIGHT);
    s = await tvState(tvOld);
    check('no photo service: the last tile is an app', s.label === 'Internet', s.label);
    await tvOld.key(K.ENTER, { hold: 900 });
    s = await tvState(tvOld);
    check('no photo service: app menu has no Hide', JSON.stringify(s.menuItems) === JSON.stringify(['Move left*', 'Move right(x)', 'Cancel']), s.menuItems);
    await tvOld.key(K.BACK);
    const oldErrors = tvOld.errors.filter((e) => !/favicon\.ico/.test(e));
    check('no photo service: no script errors', oldErrors.length === 0, oldErrors);
    await tvOld.close();

    // Input tiles (?inputs=1: 'Games console' on HDMI 2, 'Blu-ray' on HDMI 3, 'Live TV').
    const kinds = (p) => p.eval(`[...document.querySelectorAll('#dock-row .tile')].map((t) => t.className.replace('tile tile-', '').split(' ')[0])`);
    const tvIn = await browser.newPage({ width: 1920, height: 1080 });
    await tvIn.eval(`localStorage.removeItem('gh.inputOrder')`).catch(() => {});
    await tvIn.goto(base + '&still=1&inputs=1&focus=6', 4500);   // the dock remembers focus, so set it
    check('inputs: after the apps, before the shortcuts', JSON.stringify(await kinds(tvIn)) === JSON.stringify(['app', 'app', 'app', 'app', 'app', 'app', 'input', 'input', 'input', 'web', 'web', 'youtube', 'add']), await kinds(tvIn));
    s = await tvState(tvIn);
    check('inputs: in config order, with the port under the name', s.label === 'Games console' && /HDMI 2/.test(await tvIn.eval(`document.querySelector('#dock-row .tile.focused').textContent`)), s.label);
    await tvIn.key(K.ENTER, { hold: 900 });
    s = await tvState(tvIn);
    check('inputs: menu has Move and Hide, not Remove', JSON.stringify(s.menuItems) === JSON.stringify(['Move left(x)', 'Move right*', 'Hide', 'Cancel']), s.menuItems);
    await tvIn.key(K.ENTER);                // Move right
    await sleep(300);
    s = await tvState(tvIn);
    check('inputs: Move right swaps the two inputs', s.label === 'Games console' && s.focus === 7, s);
    await tvIn.goto(base + '&still=1&inputs=1&focus=6', 4500);
    s = await tvState(tvIn);
    check('inputs: the new order is kept after a restart', s.label === 'Blu-ray', s.label);
    await tvIn.key(K.ENTER);
    await sleep(400);
    s = await tvState(tvIn);
    check('OK on an input switches to it (preview toast)', /would open Blu-ray/.test(s.toast), s.toast);
    await tvIn.key(K.RIGHT);
    await tvIn.key(K.RIGHT);                // Live TV, last of the inputs
    s = await tvState(tvIn);
    const liveText = await tvIn.eval(`document.querySelector('#dock-row .tile.focused').textContent`);
    check('Live TV: after the HDMI inputs, with no port caption', s.label === 'Live TV' && !/HDMI/.test(liveText), { label: s.label, text: liveText });
    await tvIn.key(K.ENTER, { hold: 900 });
    s = await tvState(tvIn);
    check('Live TV: menu has Move left and Hide', JSON.stringify(s.menuItems) === JSON.stringify(['Move left*', 'Move right(x)', 'Hide', 'Cancel']), s.menuItems);
    await tvIn.key(K.BACK);
    await tvIn.key(K.ENTER);
    await sleep(400);
    s = await tvState(tvIn);
    check('OK on Live TV switches to it (preview toast)', /would open Live TV/.test(s.toast), s.toast);
    await tvIn.goto(base + '&still=1&inputs=1&photoService=0&focus=6', 4500);
    await tvIn.key(K.ENTER, { hold: 900 });
    s = await tvState(tvIn);
    check('inputs, no photo service: menu has no Hide or Remove', JSON.stringify(s.menuItems) === JSON.stringify(['Move left(x)', 'Move right*', 'Cancel']), s.menuItems);
    await tvIn.key(K.BACK);
    const inErrors = tvIn.errors.filter((e) => !/favicon\.ico/.test(e));
    check('inputs: no script errors', inErrors.length === 0, inErrors);
    await tvIn.eval(`localStorage.removeItem('gh.inputOrder')`);
    await tvIn.close();

    // Screensaver (?idle shortens the delay) and evening dimming.
    const tvAmb = await browser.newPage({ width: 1920, height: 1080 });
    await tvAmb.goto(base + '&bg=nature-06.jpg&idle=1500&night=1', 3000);
    await sleep(2200);
    const amb1 = await tvAmb.eval(`({ amb: document.documentElement.classList.contains('ambient'), night: document.documentElement.classList.contains('night') })`);
    check('screensaver starts after the idle time', amb1.amb === true, amb1);
    check('evening dimming on with ?night=1', amb1.night === true, amb1);
    const before1 = (await tvState(tvAmb)).focus;
    await tvAmb.key(K.RIGHT);
    await sleep(300);
    const woke = await tvAmb.eval(`document.documentElement.classList.contains('ambient')`);
    const after1 = (await tvState(tvAmb)).focus;
    check('first press only wakes the screen (focus does not move)', woke === false && after1 === before1, { woke, before1, after1 });
    await tvAmb.key(K.RIGHT);
    await sleep(300);
    check('the next press works normally', (await tvState(tvAmb)).focus === before1 + 1);
    await tvAmb.close();

    // ---------------- phone website ----------------
    console.log('Phone website');
    const ph = await browser.newPage({ width: 390, height: 844, scale: 2, mobile: true });
    await ph.goto('http://127.0.0.1:' + PORT + '/', 1800);
    check('signed-out phone sees the sign-in form', await ph.eval(`!document.getElementById('login').hidden`));
    await ph.type('#login-pw', 'not-the-password');
    await ph.click('#login-btn');
    await sleep(1300);
    const msg = await ph.eval(`document.getElementById('login-msg').textContent`);
    check('wrong password message', /Wrong password/.test(msg), msg);
    await ph.eval(`document.getElementById('login-pw').value = ''`);
    await ph.shot(path.join(OUT, 'phone-login.png'));

    await ph.goto('http://127.0.0.1:' + UI + '/dev/login?to=/%23photos', 2500);
    check('signed-in phone sees the photos tab', await ph.eval(`!document.getElementById('main').hidden && !document.getElementById('tab-photos').hidden`));
    const grid = await ph.eval(`document.querySelectorAll('#grid button').length`);
    check('photo grid shows the 2 demo photos', grid === 2, grid);

    // Upload through the real page: a portrait JPEG and a PNG, resized in the browser.
    const tmp = path.join(__dirname, 'tmp');
    const portrait = path.join(tmp, 'ui-portrait.jpg');
    const png = path.join(tmp, 'ui-landscape.png');
    const { execFileSync } = require('child_process');
    execFileSync('sips', ['-c', '1080', '720', path.join(ROOT, 'app', 'wallpapers', 'nature-02.jpg'), '--out', portrait], { stdio: 'ignore' });
    execFileSync('sips', ['-s', 'format', 'png', '-Z', '1600', path.join(ROOT, 'app', 'wallpapers', 'nature-03.jpg'), '--out', png], { stdio: 'ignore' });
    await ph.setFiles('#file-input', [portrait, png]);
    let up = 0;
    for (let i = 0; i < 40 && up < 4; i++) { await sleep(500); up = await ph.eval(`document.querySelectorAll('#grid button').length`); }
    check('two uploads from the page (portrait JPEG + PNG) appear', up === 4, up);
    const st = await ph.eval(`fetch('/api/photos', { headers: { 'X-GH': '1' } }).then(r => r.json())`);
    const newest = st.photos.slice(0, 2);
    check('uploaded photos are 1920x1080 with thumbnails', newest.every((p) => p.w === 1920 && p.h === 1080 && p.thumb), newest);
    await sleep(2800);
    await ph.shot(path.join(OUT, 'phone-photos.png'));

    await ph.click('[data-tab="shortcuts"]');
    await sleep(1200);
    await ph.type('#yt-url', 'https://youtu.be/dQw4w9WgXcQ?t=42');
    await sleep(2500);
    const prev = await ph.eval(`({ title: document.getElementById('yt-title').textContent, meta: document.getElementById('yt-meta').textContent, thumb: document.getElementById('yt-thumb').naturalWidth, btn: !document.getElementById('yt-btn').disabled })`);
    check('YouTube link previewed with title and thumbnail', prev.btn && prev.thumb > 120 && /Rick Astley/.test(prev.title) && /1:42|0:42/.test(prev.meta), prev);
    await ph.shot(path.join(OUT, 'phone-shortcuts.png'), { fullPage: true });

    await ph.type('#web-url', 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await ph.click('#web-btn');
    await sleep(600);
    const moved = await ph.eval(`document.getElementById('yt-url').value`);
    check('a YouTube link typed as a website moves to the video form', /jNQXAC9IVRw/.test(moved), moved);

    await ph.click('[data-tab="settings"]');
    await sleep(3600);                   // let the last toast fade
    await ph.shot(path.join(OUT, 'phone-settings.png'));
    const phErrors = ph.errors.filter((e) => !/favicon\.ico|status of 401/.test(e));
    check('no script errors on the phone page', phErrors.length === 0, phErrors);

    // First run as the owner will see it: the six apps and +, no shortcuts yet.
    const ids = await tv.eval(`fetch('http://127.0.0.1:${PORT}/local/state?k=' + encodeURIComponent(window.GH_LOCAL_KEY)).then(r => r.json()).then(d => d.shortcuts.map(s => s.id))`);
    for (const id of ids) await tv.eval(`fetch('http://127.0.0.1:${PORT}/local/shortcuts/${id}?k=' + encodeURIComponent(window.GH_LOCAL_KEY), { method: 'DELETE' }).then(r => r.status)`);
    const tv3 = await browser.newPage({ width: 1920, height: 1080 });
    await tv3.goto(base + '&bg=nature-04.jpg&focus=0', 4500);
    const n3 = await tv3.eval(`document.querySelectorAll('#dock-row .tile').length`);
    check('first run: six apps and +', n3 === 7, n3);
    await tv3.shot(path.join(OUT, 'tv-first-run.png'));
    await tv3.close();
  } finally {
    await browser.close();
    runner.kill('SIGTERM');
    await sleep(500);
    for (const f of ['ui-portrait.jpg', 'ui-landscape.png']) {
      try { fs.unlinkSync(path.join(__dirname, 'tmp', f)); } catch (e) { /* not created */ }
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
