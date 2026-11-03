#!/usr/bin/env node
// Runs the real startup and selection code with a minimal DOM, controlled
// service replies and timers. Records every dock render, not just final state.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const netflix = 'org.tizen.netflix-app', plus = 'com.samsung.tv.tvPlusDeeplinker';
const entries = [{ appId: netflix, label: 'Netflix' }, { appId: plus, label: 'Samsung TV Plus' }];
let checks = 0;
function equal(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message); checks++;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }

function boot(options = {}) {
  const history = [], nodes = {}, listeners = {}, timeouts = new Map(), intervals = new Map();
  const preferences = deferred(), catalog = deferred();
  let sequence = 0, preferenceReads = 0, launches = 0;
  class Element {
    constructor(id) {
      this.id = id; this.children = []; this.parent = null; this.className = ''; this.text = ''; this.attrs = {};
      this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] || ''; } };
      this.offsetWidth = 100;
      this.classList = {
        contains: c => this.className.split(' ').includes(c),
        toggle: (c, on) => {
          const classes = new Set(this.className.split(' ').filter(Boolean));
          if (on === undefined) on = !classes.has(c);
          if (on) classes.add(c); else classes.delete(c);
          this.className = [...classes].join(' ');
        },
        add: c => this.classList.toggle(c, true),
        remove: c => this.classList.toggle(c, false)
      };
    }
    set textContent(value) { this.text = String(value); this.children.forEach(c => { c.parent = null; }); this.children = []; }
    get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
    appendChild(child) {
      if (child.fragment) { [...child.children].forEach(c => this.appendChild(c)); return child; }
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this; this.children.push(child);
      if (this.id === 'dock-row') history.push(labels());
      return child;
    }
    setAttribute(k, value) { this.attrs[k] = value; }
  }
  const get = id => nodes[id] || (nodes[id] = new Element(id));
  const labels = () => get('dock-row').children.filter(e => e.classList.contains('tile-app')).map(e => e.textContent);
  const document = {
    hidden: false, documentElement: new Element(),
    getElementById: get, createElement: () => new Element(), createElementNS: () => new Element(),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
    addEventListener: (event, fn) => { listeners[event] = fn; }
  };
  const stored = {
    'gh.vetro.v1': { entries: options.noCatalog ? [] : entries, selected: null },
    'gh.hidden': [], 'gh.focus': 'app:netflix',
    'gh.apps.v1': { apps: { netflix: { id: netflix }, tvplus: { id: plus } } }
  };
  const window = { tizen: {}, innerWidth: 1920, innerHeight: 1080, addEventListener: () => {} };
  const context = vm.createContext({
    window, document, location: { search: options.focus === undefined ? '' : '?focus=' + options.focus },
    setTimeout: (fn, ms) => { const id = ++sequence; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: (fn, ms) => { const id = ++sequence; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id), Image: function () { return new Element(); }
  });
  const run = name => vm.runInContext(fs.readFileSync(path.join(root, 'app/js', name), 'utf8'), context);
  run('config.js');
  const GH = window.GH;
  GH.config.photoService = !options.noService;
  GH.config.inputs = [{ hdmi: 2, label: 'Games console' }];
  GH.ls = { get: k => stored[k] || null, set: (k, v) => { stored[k] = JSON.parse(JSON.stringify(v)); } };
  const state = { photos: [], shortcuts: [] };
  GH.data = {
    cached: () => state, health: () => Promise.resolve(!options.offline),
    refresh: () => Promise.resolve({ state, changed: true, online: !options.offline }),
    dockPreferences: () => { preferenceReads++; return preferences.promise; },
    saveDockPreferences: p => Promise.resolve(p), vetroApps: () => catalog.promise,
    media: p => p
  };
  GH.platform = {
    isTV: false, iconUrl: () => null, setYouTubeId: () => {},
    launchApp: () => { launches++; return Promise.resolve(); },
    resolveApps: definitions => Promise.resolve(Object.fromEntries(definitions.map(d => [d.key, { id: d.ids[0] }])))
  };
  GH.request = () => Promise.resolve({ status: 200, data: [] });
  GH.Backdrop = function () { this.setPhotos = this.start = this.pause = this.resume = () => {}; };
  run('vetro-apps.js'); run('home.js');
  return {
    GH, history, preferences, catalog, get, labels, options,
    reads: () => preferenceReads, launches: () => launches,
    poll: () => { [...intervals.values()].forEach(t => t.fn()); },
    expire: ms => { for (const [id, t] of [...timeouts]) if (t.ms === ms) { timeouts.delete(id); t.fn(); } },
    foreground: () => listeners.visibilitychange(),
    key: code => {
      let prevented = false;
      listeners.keydown({ keyCode: code, preventDefault: () => { prevented = true; } });
      listeners.keyup({ keyCode: code });
      return prevented;
    }
  };
}

(async () => {
  const t = boot();
  equal([t.labels(), t.get('dock').style.visibility, t.get('dock').attrs['aria-busy']], [[], 'hidden', 'true'], 'initial cache is not rendered');
  await settle(); t.poll(); await settle();
  equal(t.labels(), [], 'installed-app discovery and background polling cannot expose stale choices');
  equal(t.reads(), 1, 'startup coalesces preference reads');
  equal([t.key(13), t.launches()], [true, 0], 'remote cannot launch a stale app while preferences load');
  t.preferences.resolve({ selected: [netflix], hidden: ['in:2'] });
  await settle();
  equal(t.labels(), ['Netflix'], 'first dock uses restored selection');
  equal(t.history.every(render => !render.includes('Samsung TV Plus')), true, 'removed app never appears in any startup render');
  equal(t.get('dock-row').children.some(e => e.classList.contains('tile-input')), false, 'hidden input never appears');
  equal([t.GH.vetro.loading, t.get('dock').style.visibility], [true, ''], 'dock is usable before the slower Vetro read finishes');
  t.catalog.resolve({ available: true, apps: entries }); await settle();
  equal(t.labels(), ['Netflix'], 'catalog refresh retains restored selection');
  t.expire(6000); await settle();
  equal(t.labels(), ['Netflix'], 'cancelled startup fallback cannot replace restored choices');

  for (const selection of [[netflix], []]) {
    const cold = boot({ noCatalog: true }); await settle();
    cold.preferences.resolve({ selected: selection, hidden: [] }); await settle();
    equal(cold.labels(), selection.length ? ['Netflix'] : [], 'missing catalog still filters configured fallback by saved selection');
    equal(cold.history.every(render => !render.includes('Samsung TV Plus')), true, 'missing catalog never flashes an excluded configured app');
  }
  const hidden = boot({ noCatalog: true }); await settle();
  hidden.preferences.resolve({ selected: null, hidden: ['tvplus'] }); await settle();
  equal(hidden.labels().includes('Samsung TV Plus'), false, 'all-apps mode restores hiding before first render');

  const failed = boot(); await settle();
  failed.preferences.reject(new Error('unavailable')); await settle();
  equal(failed.labels(), ['Netflix', 'Samsung TV Plus'], 'failed restoration releases cached fallback');
  equal([failed.get('dock').style.visibility, failed.GH.vetro.preferencesError], ['', true], 'failure keeps dock usable with an error state');

  const offline = boot({ offline: true }); await settle();
  equal(offline.labels(), [], 'offline startup initially waits');
  offline.expire(6000); await settle();
  equal(offline.labels(), ['Netflix', 'Samsung TV Plus'], 'bounded timeout releases the cached dock');
  offline.options.offline = false; offline.foreground(); await settle();
  offline.preferences.resolve({ selected: [netflix], hidden: [] }); await settle();
  equal(offline.labels(), ['Netflix'], 'service recovery applies preferences before catalog response');

  const native = boot({ noService: true, focus: 1 }); await settle();
  equal(native.reads(), 0, 'service-disabled mode does not wait for preferences');
  equal(native.get('dock-row').children.filter(e => e.classList.contains('tile-app')).length, 6, 'service-disabled configured apps render immediately');
  equal(native.get('label').textContent, 'Netflix', 'initial requested focus survives startup');
  const focused = boot({ focus: 1 }); await settle();
  focused.preferences.resolve({ selected: [netflix, plus], hidden: [] }); await settle();
  equal(focused.get('label').textContent, 'Samsung TV Plus', 'initial focus is applied after preferences are restored');
  console.log(checks + ' startup rendering checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
