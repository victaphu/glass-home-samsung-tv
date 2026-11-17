/*
 * Glass Home - screensaver and evening dimming.
 *
 * Screensaver: after config.ambient.afterMs without a button press, the dock,
 * clock, weather, logo and photo credit fade out and only the
 * photos drift (html.ambient). The first button press only brings them back;
 * it is not passed on, so waking the screen never opens an app by accident.
 * Not while the + panel or a menu is open.
 *
 * Evening dimming: between config.night.from and config.night.to (TV clock)
 * a dark layer dims the photos (html.night); the dock and text stay bright.
 *
 * Preview and tests: ?idle=<ms> shortens the screensaver delay; ?night=1 or
 * ?night=0 forces dimming on or off.
 */
(function () {
  'use strict';
  var GH = window.GH || {};
  var cfg = GH.config || {};
  var Q = GH.query || {};
  var html = document.documentElement;
  var amb = cfg.ambient || {};
  var night = cfg.night || {};
  var idleMs = /^\d+$/.test(Q.idle || '') ? +Q.idle : (amb.afterMs || 3 * 60 * 1000);
  var timer = null;
  var swallowKey = null;

  function isOpen(id) {
    var e = document.getElementById(id);
    return !!(e && e.classList.contains('open'));
  }

  function arm() {
    clearTimeout(timer);
    if (amb.enabled === false) return;
    timer = setTimeout(enter, idleMs);
  }

  function enter() {
    if (document.hidden) return;
    if (isOpen('panel') || isOpen('menu') || isOpen('settings')) { arm(); return; }
    html.classList.add('ambient');
  }

  function wake() {
    html.classList.remove('ambient');
    arm();
  }

  // Window capture runs before the home screen's own (document) key handler.
  window.addEventListener('keydown', function (e) {
    if (html.classList.contains('ambient')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      swallowKey = e.keyCode;
      wake();
      return;
    }
    arm();
  }, true);
  window.addEventListener('keyup', function (e) {
    if (swallowKey !== null && e.keyCode === swallowKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      swallowKey = null;
    }
  }, true);

  // ---------- evening dimming ----------
  function minutes(hhmm) {
    var p = String(hhmm || '').split(':');
    return (+p[0] || 0) * 60 + (+p[1] || 0);
  }
  function nightCheck() {
    var on;
    if (Q.night === '1') on = true;
    else if (Q.night === '0' || night.enabled === false) on = false;
    else {
      var now = new Date();
      var m = now.getHours() * 60 + now.getMinutes();
      var from = minutes(night.from || '20:00');
      var to = minutes(night.to || '06:00');
      on = from > to ? (m >= from || m < to) : (m >= from && m < to);
    }
    html.classList.toggle('night', on);
  }

  var nightTimer = null;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearTimeout(timer);
      clearInterval(nightTimer);
      return;
    }
    nightCheck();
    clearInterval(nightTimer);
    nightTimer = setInterval(nightCheck, 60000);
    wake();
  });

  nightCheck();
  nightTimer = setInterval(nightCheck, 60000);
  arm();
}());
