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
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : cfg.vetroApps === true,
    entries: valid(saved.entries),
    selected: Array.isArray(saved.selected) ? saved.selected.filter(function (s) { return typeof s === 'string'; }) : null,
    available: false,
    loading: false
  };
  var pending = null;
  function persist() { ls.set('gh.vetro.v1', { enabled: V.enabled, entries: V.entries, selected: V.selected }); }
  V.save = function (enabled, ids) {
    V.enabled = !!enabled;
    V.selected = ids.slice();
    persist();
  };
  V.refresh = function () {
    if (pending) return pending;
    V.loading = true;
    pending = GH.data.vetroApps().then(function (result) {
      var entries = valid(result && result.apps);
      V.available = !!(result && result.available && entries.length);
      if (V.available) {
        V.entries = entries;
        // The first import selects all. Later refreshes keep explicit choices.
        if (V.selected === null) V.selected = entries.map(function (e) { return e.appId; });
        persist();
      }
    }, function () { V.available = false; }).then(function () {
      V.loading = false; pending = null;
      return V;
    });
    return pending;
  };
  V.active = function () { return V.enabled && V.entries.length > 0; };
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
