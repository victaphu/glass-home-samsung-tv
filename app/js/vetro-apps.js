/* Optional Vetro catalog and saved dock selection. No Vetro control calls. */
(function () {
  'use strict';
  var GH = window.GH, cfg = GH.config, ls = GH.ls;
  var saved = ls.get('gh.vetro.v1') || {};
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
    available: false,
    loading: false,
    error: null
  };
  var pending = null;
  function persist() { ls.set('gh.vetro.v1', { entries: V.entries, selected: V.selected }); }
  V.save = function (ids) {
    V.selected = ids === null ? null : ids.slice();
    persist();
  };
  V.refresh = function (refresh) {
    if (pending) return pending;
    V.loading = true;
    pending = GH.data.vetroApps(refresh).then(function (result) {
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
  V.definitions = function () {
    if (!V.active()) return cfg.apps;
    return V.entries.filter(function (e) { return V.selected === null || V.selected.indexOf(e.appId) >= 0; }).map(function (e) {
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
