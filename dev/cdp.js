// Glass Home - tiny DevTools-protocol driver for a headless Chromium browser
// (dev only). Starts the browser with a throwaway profile and a debugging port on 127.0.0.1,
// and offers: open a page, press keys (including a held OK), evaluate, and
// take screenshots. Background networking, sync, extensions and the media
// router (LAN casting discovery) are switched off.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Any Chromium-based browser works. Set BROWSER to its executable to choose one.
const CANDIDATES = [
  process.env.BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);
const BRAVE = CANDIDATES.find((p) => fs.existsSync(p)) || CANDIDATES[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });
  const profile = fs.mkdtempSync(path.join(__dirname, 'tmp', 'brave-'));
  const proc = spawn(BRAVE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-notifications', '--mute-audio',
    '--disable-features=MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider,Translate,OptimizationHints',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Register before shutdown so even an immediate exit cannot be missed.
  const exited = new Promise((resolve) => proc.once('close', resolve));
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Brave did not start')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', () => { clearTimeout(t); reject(new Error('Brave exited')); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const handlers = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method) {
      handlers.forEach((h) => h(msg));
    }
  };
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });

  async function newPage({ width, height, scale = 1, mobile = false }) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const errors = [];
    const logs = [];
    handlers.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push('log: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    });
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Log.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    if (mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const page = {
      errors, logs,
      async goto(url, settleMs = 1500) {
        const loaded = new Promise((resolve) => {
          const h = (msg) => { if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') { handlers.splice(handlers.indexOf(h), 1); resolve(); } };
          handlers.push(h);
        });
        await s('Page.navigate', { url });
        await Promise.race([loaded, sleep(15000)]);
        await sleep(settleMs);
      },
      async eval(expr) {
        const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
        return r.result.value;
      },
      async key(code, { hold = 0 } = {}) {
        const names = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 27: 'Escape', 8: 'Backspace' };
        const base = { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: names[code] || 'Unidentified', code: names[code] || '' };
        await s('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
        if (hold) {
          // a remote held down: auto-repeated keydowns, then one keyup
          const until = Date.now() + hold;
          while (Date.now() < until) {
            await sleep(100);
            await s('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown', autoRepeat: true }, base));
          }
        }
        await s('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
        await sleep(120);
      },
      async click(selector) {
        const box = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block: 'center'}); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (!box) throw new Error('no element ' + selector);
        await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await sleep(150);
      },
      async type(selector, text) {
        await page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
        await s('Input.insertText', { text });
        await sleep(100);
      },
      async setFiles(selector, files) {
        const doc = await s('DOM.getDocument', { depth: 1 });
        const q = await s('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
        await s('DOM.setFileInputFiles', { nodeId: q.nodeId, files });
      },
      async shot(file, opts = {}) {
        const params = { format: 'png' };
        if (opts.fullPage) {
          const m = await s('Page.getLayoutMetrics');
          params.clip = { x: 0, y: 0, width: m.cssContentSize.width, height: m.cssContentSize.height, scale: 1 };
          params.captureBeyondViewport = true;
        }
        const r = await s('Page.captureScreenshot', params);
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        return file;
      },
      clearCookies: () => s('Network.clearBrowserCookies'),
      close: () => send('Target.closeTarget', { targetId })
    };
    return page;
  }

  async function waitForExit(ms) {
    let timer;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })
      ]);
    } finally { clearTimeout(timer); }
  }

  async function close() {
    // The CDP reply is not proof the browser has exited, and may never arrive
    // when it shuts its socket first. Wait for the child process instead.
    send('Browser.close').catch(() => {});
    try {
      if (!await waitForExit(5000)) {
        proc.kill('SIGKILL');
        if (!await waitForExit(5000)) throw new Error('Browser did not exit during cleanup');
      }
    } finally {
      try { ws.close(); } catch (e) { /* already closed */ }
    }
    // Chromium helpers can briefly keep profile files busy after the parent
    // exits. Retry transient ENOTEMPTY/EBUSY errors, but still fail if persistent.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  return { newPage, close, sleep };
}

module.exports = { launch, sleep };
