/*
 * Glass Home - client for the app's own photo/shortcut service.
 *
 * Talks to http://127.0.0.1:8090 (loopback) with the package's local key.
 * The last good state is kept in localStorage, so the dock and the photo list
 * still work from cache when the service is not running.
 *
 * The website password is never stored by the app. It is shown only while the
 * service is running, as the service reports it, and is kept in this page's
 * memory meanwhile. (The website cannot be reached while the service is down,
 * so a stored copy would only be a secret lying on disk.)
 */
(function () {
  'use strict';
  var GH = window.GH;
  var cfg = GH.config;
  var base = cfg.serviceBase.replace(/\/+$/, '');
  var key = window.GH_LOCAL_KEY || '';
  var STATE_KEY = 'gh.state.v1';
  var OLD_PW_KEY = 'gh.pw.v1';      // where older builds kept the plain password
  var current = null;
  var fresh = false;                 // `current` came from the service in this run
  var online = null;                 // the last refresh reached the service
  var pwMem = null;                  // { id, plain }: memory only, never stored

  var ls = {
    get: function (k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }
  };
  GH.ls = ls;
  try { localStorage.removeItem(OLD_PW_KEY); } catch (e) { /* storage blocked */ }

  // XMLHttpRequest rather than fetch: it also reads the app's own files on the
  // TV (file:// URLs), where fetch() is not allowed.
  function request(method, url, body, timeoutMs) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      var done = false;
      function finish(status, text) {
        if (done) return;
        done = true;
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        resolve({ status: status, data: data });
      }
      try {
        x.open(method, url, true);
        x.timeout = timeoutMs || 6000;
        if (body !== undefined) x.setRequestHeader('Content-Type', 'application/json');
        x.onload = function () { finish(x.status || (x.responseText ? 200 : 0), x.responseText); };
        x.onerror = function () { finish(0, null); };
        x.ontimeout = function () { finish(0, null); };
        x.send(body === undefined ? null : JSON.stringify(body));
      } catch (e) { finish(0, null); }
    });
  }
  GH.request = request;

  function withKey(path) {
    return base + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(key);
  }

  var D = {};
  D.base = base;
  D.media = function (path) { return path ? withKey(path) : null; };

  D.health = function (timeoutMs) {
    return request('GET', base + '/health', undefined, timeoutMs || 2500).then(function (r) {
      return r.status === 200 && r.data && r.data.ok === true;
    });
  };

  D.cached = function () {
    if (!current) current = ls.get(STATE_KEY);
    return current;
  };

  D.vetroApps = function (refresh) {
    return request('GET', withKey('/local/vetro/apps' + (refresh ? '?refresh=1' : '')), undefined, 28000).then(function (r) {
      if (r.status !== 200 || !r.data) throw new Error('Vetro unavailable');
      return r.data;
    });
  };

  // Fetches the state; resolves { state, changed, online }. The first fetch in
  // each run asks for the full state (no ?rev=), because the stored copy never
  // holds the password and the service only sends it with the full state.
  D.refresh = function () {
    var have = D.cached();
    var url = withKey('/local/state' + (fresh && have && have.rev ? '?rev=' + have.rev : ''));
    return request('GET', url, undefined, 5000).then(function (r) {
      if (r.status !== 200 || !r.data) { online = false; return { state: have, changed: false, online: false }; }
      online = true;
      if (r.data.same && have) {
        have.service = r.data.service;
        have.lan = r.data.lan;
        return { state: have, changed: false, online: true };
      }
      current = r.data;
      fresh = true;
      if (r.data.password && r.data.password.plain) pwMem = { id: r.data.password.id, plain: r.data.password.plain };
      var slim = JSON.parse(JSON.stringify(r.data));
      if (slim.password) slim.password.plain = null;          // the password itself is never stored
      ls.set(STATE_KEY, slim);
      return { state: current, changed: true, online: true };
    });
  };

  // The password to show on the TV: { text, note }.
  D.passwordView = function () {
    if (online !== true) return { text: null, note: 'The photo website is starting. The password shows here once it is running.' };
    var st = D.cached();
    var pw = st && st.password;
    if (pw && pw.plain) return { text: pw.plain, note: '' };
    if (pwMem && (!pw || pwMem.id === pw.id)) return { text: pwMem.plain, note: '' };
    if (pw && pw.generated) return { text: null, note: 'The TV doesn’t have this password to show (it was made before an update). New password makes one to show here; phones then sign in again.' };
    if (pw) return { text: null, note: 'The password was changed on a phone or computer. Choose New password to show one here.' };
    return { text: null, note: 'Waiting for the photo service to start…' };
  };

  D.newPassword = function () {
    return request('POST', withKey('/local/password'), {}, 8000).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.plain) throw new Error('service');
      pwMem = { id: r.data.id, plain: r.data.plain };
      online = true;
      if (current) {
        current.password = { id: r.data.id, generated: true, plain: r.data.plain };
        current.rev = 0;                                       // force a full refresh next time
      }
      return r.data.plain;
    });
  };

  D.removeShortcut = function (id) {
    return request('DELETE', withKey('/local/shortcuts/' + encodeURIComponent(id)), undefined, 5000).then(function (r) {
      if (r.status !== 200) throw new Error('service');
      if (current) { current.shortcuts = (current.shortcuts || []).filter(function (s) { return s.id !== id; }); current.rev = 0; }
    });
  };

  D.orderShortcuts = function (ids) {
    return request('POST', withKey('/local/shortcuts/order'), { ids: ids }, 5000).then(function (r) {
      if (r.status !== 200) throw new Error('service');
      if (current) current.rev = 0;
    });
  };

  GH.data = D;
}());

