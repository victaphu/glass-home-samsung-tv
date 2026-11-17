/* Glass Home - validated local overrides, applied before weather and ambient. */
(function () {
  'use strict';
  var GH = window.GH;
  var c = GH.config;
  var KEY = 'gh.preferences.v1';
  var defaults = {
    photoSec: c.photoIntervalMs / 1000,
    matchSky: !!(c.photos && c.photos.matchSky),
    screensaverMin: c.ambient.enabled ? c.ambient.afterMs / 60000 : 0,
    dim: c.night.enabled,
    dimFrom: c.night.from,
    dimTo: c.night.to,
    unit: c.weather.temperatureUnit
  };
  function clean(s) {
    var out = {};
    if (!s || typeof s !== 'object') return out;
    ['photoSec', 'screensaverMin'].forEach(function (k) {
      if (typeof s[k] === 'number' && isFinite(s[k]) &&
          s[k] >= (k === 'photoSec' ? 10 : 0) && s[k] <= 3600) out[k] = s[k];
    });
    ['matchSky', 'dim'].forEach(function (k) { if (typeof s[k] === 'boolean') out[k] = s[k]; });
    ['dimFrom', 'dimTo'].forEach(function (k) { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s[k])) out[k] = s[k]; });
    if (s.unit === 'fahrenheit' || s.unit === 'celsius') out.unit = s.unit;
    return out;
  }
  var saved = {};
  try { saved = clean(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch (e) { /* defaults */ }
  var effective = {};
  Object.keys(defaults).forEach(function (k) { effective[k] = saved[k] === undefined ? defaults[k] : saved[k]; });
  c.photoIntervalMs = effective.photoSec * 1000;
  if (c.photos) c.photos.matchSky = effective.matchSky;
  c.ambient.enabled = effective.screensaverMin > 0;
  c.ambient.afterMs = effective.screensaverMin * 60000;
  c.night.enabled = effective.dim;
  c.night.from = effective.dimFrom;
  c.night.to = effective.dimTo;
  c.weather.temperatureUnit = effective.unit;
  GH.preferences = {
    defaults: defaults, effective: effective, clean: clean,
    save: function (values) {
      var overrides = clean(values);
      Object.keys(overrides).forEach(function (k) { if (overrides[k] === defaults[k]) delete overrides[k]; });
      try { localStorage.setItem(KEY, JSON.stringify(overrides)); return true; } catch (e) { return false; }
    },
    reset: function () { try { localStorage.removeItem(KEY); return true; } catch (e) { return false; } }
  };
}());
