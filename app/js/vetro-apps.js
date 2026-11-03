/* Optional Vetro catalog and saved dock selection. No Vetro control calls. */
(function () {
  'use strict';
  var GH = window.GH, cfg = GH.config, ls = GH.ls;
  var saved = ls.get('gh.vetro.v1') || {}, savedHidden = ls.get('gh.hidden');
  function valid(list) {
    var seen = Object.create(null);
    return (Array.isArray(list) ? list : []).filter(function (e) {
      if (!e || typeof e.appId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(e.appId) || typeof e.label !== 'string' || seen[e.appId]) return false;
      seen[e.appId] = true;
      return true;
    }).slice(0, 100);
  }
  var V = {
    entries: valid(saved.entries),
    selected: Array.isArray(saved.selected) ? saved.selected.filter(function (s) { return typeof s === 'string'; }) : null,
    hidden: Array.isArray(savedHidden) ? savedHidden.slice() : [],
    preferencesReady: false,
    preferencesError: false,
    saving: false,
    available: false,
    loading: false,
    error: null
  };
  var pending = null;
  var restoring = null;
  function persist() { ls.set('gh.vetro.v1', { entries: V.entries, selected: V.selected }); }
  function applyPreferences(prefs) {
    if (!prefs || !(prefs.selected === null || Array.isArray(prefs.selected)) || !Array.isArray(prefs.hidden)) throw new Error('invalid preferences');
    V.selected = prefs.selected === null ? null : prefs.selected.slice();
    V.hidden = prefs.hidden.slice();
    persist();
    ls.set('gh.hidden', V.hidden);
  }
  V.loadPreferences = function () {
    if (V.preferencesReady) return Promise.resolve();
    if (restoring) return restoring;
    restoring = GH.data.dockPreferences().then(function (prefs) {
      return prefs === null ? GH.data.saveDockPreferences({ selected: V.selected, hidden: V.hidden }, true) : prefs;
    }).then(function (prefs) {
      applyPreferences(prefs);
      V.preferencesReady = true;
      V.preferencesError = false;
      restoring = null;
    }).catch(function (err) { V.preferencesError = true; restoring = null; throw err; });
    return restoring;
  };
  V.save = function (ids, hidden) {
    if (!V.preferencesReady || V.saving) return Promise.reject(new Error('preferences not ready'));
    V.saving = true;
    return GH.data.saveDockPreferences({ selected: ids === null ? null : ids.slice(), hidden: (hidden || V.hidden).slice() }).then(function (prefs) {
      applyPreferences(prefs);
      V.saving = false;
    }).catch(function (err) { V.saving = false; throw err; });
  };
  V.refresh = function (refresh) {
    if (pending) return pending;
    V.loading = true;
    pending = V.loadPreferences().catch(function () { /* use cached choices until retry */ }).then(function () {
      return GH.data.vetroApps(refresh);
    }).then(function (result) {
      var entries = valid(result && result.apps);
      V.available = !!(result && result.available && entries.length);
      V.error = V.available ? null : result && result.error || null;
      if (V.available) {
        V.entries = entries;
        // null means all apps, including new arrivals; explicit subsets persist.
        persist();
      }
    }, function (err) {
      V.available = false;
      V.error = err && err.vetro || { code: 'service', message: 'Glass Home could not retrieve its app list.' };
    }).then(function () {
      V.loading = false; pending = null;
      return V;
    });
    return pending;
  };
  V.failureText = function () {
    var e = V.error || {};
    if (e.code === 'empty') return 'Vetro has no launchable apps';
    if (e.code === 'timeout') return 'Vetro did not respond';
    if (e.code === 'http') return 'Vetro returned HTTP ' + e.status;
    if (e.code === 'connection' || e.code === 'request') return 'Could not connect to Vetro';
    if (e.code === 'service') return 'Glass Home could not retrieve its app list';
    if (e.code) return 'Could not read the Vetro app list';
    return 'Vetro app list unavailable';
  };
  V.diagnostic = function () {
    var e = V.error;
    if (!e) return '';
    return ['Vetro', e.code, e.detail, e.message].filter(function (s) { return !!s; }).join(' · ').slice(0, 360);
  };
  V.active = function () { return V.entries.length > 0; };
  V.definitions = function (selection) {
    var selected = arguments.length ? selection : V.selected;
    if (!V.active()) return cfg.apps;
    return V.entries.filter(function (e) { return selected === null || selected.indexOf(e.appId) >= 0; }).map(function (e) {
      var known = cfg.apps.filter(function (d) { return d.ids.indexOf(e.appId) >= 0; })[0];
      var def = { key: known ? known.key : 'vetro:' + e.appId, label: e.label, ids: [e.appId], names: [], fromVetro: true };
      if (known) {
        def.ids = [e.appId].concat(known.ids.filter(function (id) { return id !== e.appId; }));
        def.storeId = known.storeId;
        if (known.icon !== undefined) def.icon = known.icon;
      }
      return def;
    });
  };
  GH.vetro = V;
}());
