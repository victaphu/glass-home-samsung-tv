/* Glass Home - remote-controlled settings, saved only on this TV. */
(function () {
  'use strict';
  var GH = window.GH;
  var root = document.getElementById('settings');
  var prefs = GH.preferences;
  var DEFAULTS = prefs && prefs.defaults;
  var K = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8 };
  var resetting = false;
  if (!root || !prefs) return;
  function hour(h) { return h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM'; }
  function range(a, b) { var out = []; for (var i = a; i <= b; i++) out.push(i); return out; }
  var onOff = [[true, 'On'], [false, 'Off']];

  // Each row: a label and its choices [value, text].
  function rows(tv) {
    var list = [
      { section: 'Photos' },
      { key: 'photoSec', label: 'New photo every', choices: [[30, '30 s'], [45, '45 s'], [60, '1 min'], [120, '2 min'], [300, '5 min']] },
      { key: 'screensaverMin', label: 'Screensaver after', choices: [[0, 'Never'], [1, '1 min'], [3, '3 min'], [5, '5 min'], [10, '10 min']] },
      { key: 'dim', label: 'Dim photos in the evening', choices: onOff }
    ];
    if (GH.config.photos) list.splice(2, 0, { key: 'matchSky', label: 'Photos match the sky', choices: onOff });
    if (tv.dim) {
      list.push({ key: 'dimFrom', label: 'Dim from', choices: range(0, 23).map(function (h) { return [('0' + h).slice(-2) + ':00', hour(h)]; }) });
      list.push({ key: 'dimTo', label: 'Until', choices: range(0, 23).map(function (h) { return [('0' + h).slice(-2) + ':00', hour(h)]; }) });
    }
    list.push({ section: 'Home screen' });
    list.push({ key: 'unit', label: 'Temperature', choices: [['fahrenheit', '°F'], ['celsius', '°C']] });
    list.push({ section: '' });
    list.push({ reset: true, label: 'Reset to the defaults' });
    return list;
  }

  var view = false;
  var tv = null;
  var start = '';
  var focus = 1;
  var list = [];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  function valueText(r) {
    if (r.reset) return '';
    var v = tv[r.key];
    var c = r.choices.filter(function (x) { return x[0] === v; })[0];
    return c ? c[1] : String(v);
  }

  function change(r, dir) {
    if (r.reset) {
      tv = copy(DEFAULTS);
      resetting = true;
    } else {
      var vals = r.choices.map(function (x) { return x[0]; });
      var at = vals.indexOf(tv[r.key]);
      if (at < 0) at = 0; else at = (at + dir + vals.length) % vals.length;
      tv[r.key] = vals[at];
    }
    list = rows(tv);
    focus = Math.min(focus, list.length - 1);
  }

  function render() {
    clear(root);
    var page = el('div', 'st-page');
    var head = el('div', 'st-head');
    head.appendChild(el('div', 'st-title', 'Settings'));
    head.appendChild(el('div', 'st-hint', '◀ ▶ change · Back to save and apply'));
    page.appendChild(head);
    var track = el('div', 'st-list');
    list.forEach(function (r, i) {
      if (r.section != null) { track.appendChild(el('div', 'st-section', r.section)); return; }
      var row = el('div', 'st-row' + (i === focus ? ' focused' : '') + (r.reset ? ' st-reset' : ''));
      row.appendChild(el('span', 'st-label', r.label));
      if (!r.reset) {
        var val = el('span', 'st-value');
        val.appendChild(el('span', 'st-arrow', '◀'));
        val.appendChild(el('span', 'st-val', valueText(r)));
        val.appendChild(el('span', 'st-arrow', '▶'));
        row.appendChild(val);
      }
      track.appendChild(row);
    });
    page.appendChild(track);
    root.appendChild(page);
    // Keep the focused row in view.
    var f = track.querySelector('.focused');
    if (f) {
      var y = f.offsetTop - 380;
      track.style.transform = 'translateY(' + (-Math.max(0, y)) + 'px)';
    }
  }

  function open() {
    tv = copy(prefs.effective);
    resetting = false;
    start = JSON.stringify(tv);
    list = rows(tv);
    focus = 1;
    view = true;
    root.classList.add('open');
    render();
  }

  function close() {
    if (JSON.stringify(tv) !== start || resetting) {
      var success = resetting && JSON.stringify(tv) === JSON.stringify(DEFAULTS) ? prefs.reset() : prefs.save(tv);
      if (!success) {
        root.querySelector('.st-hint').textContent = 'Settings could not be saved. Free storage and try Back again.';
        return;
      }
      location.reload();
      return;
    }
    view = false;
    root.classList.remove('open');
    clear(root);
  }

  function move(dir) {
    var i = focus;
    do { i += dir; } while (i >= 0 && i < list.length && list[i].section != null);
    if (i >= 0 && i < list.length) focus = i;
  }

  function onKey(e) {
    if (!view) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    var k = e.keyCode;
    var r = list[focus];
    if (k === K.BACK || k === K.ESC || k === K.BACKSPACE) { close(); return; }
    if (k === K.UP) move(-1);
    else if (k === K.DOWN) move(1);
    else if (k === K.LEFT) change(r, -1);
    else if (k === K.RIGHT || (k === K.ENTER && !e.repeat)) change(r, 1);
    render();
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  GH.settings = { open: open, isOpen: function () { return view; } };

}());
