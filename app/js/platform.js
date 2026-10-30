/*
 * Glass Home - Tizen calls: find apps, launch them, open websites and YouTube
 * links, start the photo service. In preview mode everything is mocked.
 *
 * Privileges used (all public level): application.launch (launch,
 * launchAppControl), application.info. getAppInfo/getAppsInfo need none.
 */
(function () {
  'use strict';
  var GH = window.GH;
  var cfg = GH.config;
  var tz = !cfg.preview && typeof window.tizen !== 'undefined' ? window.tizen : null;
  var VIEW = 'http://tizen.org/appcontrol/operation/view';
  var P = {};

  P.isTV = !!tz;
  P.packageId = 'GlassHome1';
  try { if (tz) P.packageId = tz.application.getCurrentApplication().appInfo.packageId; } catch (e) { /* keep default */ }
  P.serviceId = P.packageId + '.' + cfg.serviceName;

  // "Disney+" -> "disney plus", "Prime Video" -> "prime video"
  function norm(name) {
    return String(name || '').toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  P.norm = norm;

  function matchByName(defs, list, result) {
    var taken = {};
    Object.keys(result).forEach(function (k) { taken[result[k].id] = true; });
    var apps = (list || []).filter(function (a) { return a && a.id && a.show !== false; });
    defs.forEach(function (def) {
      if (result[def.key]) return;
      for (var p = 0; p < def.names.length && !result[def.key]; p++) {
        var re = new RegExp(def.names[p]);
        for (var i = 0; i < apps.length; i++) {
          var a = apps[i];
          if (taken[a.id] || !re.test(norm(a.name))) continue;
          result[def.key] = { id: a.id, name: a.name, iconPath: a.iconPath || null };
          taken[a.id] = true;
          break;
        }
      }
    });
    return result;
  }
  P.matchByName = matchByName;

  // Resolves { key: { id, name, iconPath } } for the dock apps that are installed.
  P.resolveApps = function (defs) {
    if (!tz) {
      var mock = (window.GH_MOCK && window.GH_MOCK.apps) || [];
      return Promise.resolve(matchByName(defs, mock, {}));
    }
    var result = {};
    defs.forEach(function (def) {
      for (var i = 0; i < def.ids.length; i++) {
        try {
          var info = tz.application.getAppInfo(def.ids[i]);
          if (info && info.id) { result[def.key] = { id: info.id, name: info.name, iconPath: info.iconPath || null }; break; }
        } catch (e) { /* NotFoundError: try the next id */ }
      }
    });
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(result); } }, 4000);
      try {
        tz.application.getAppsInfo(function (list) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(matchByName(defs, list, result));
        }, function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(result);
        });
      } catch (e) {
        done = true;
        clearTimeout(timer);
        resolve(result);
      }
    });
  };

  P.iconUrl = function (iconPath) {
    if (!iconPath) return null;
    var s = String(iconPath);
    if (/^(file|https?|data):/i.test(s)) return s;
    if (s.charAt(0) === '/') return 'file://' + s;
    return s;
  };

  function previewLaunch(what) {
    return new Promise(function (resolve) { setTimeout(function () { resolve('preview:' + what); }, 150); });
  }

  // Asks Samsung's launcher (the TV's local REST API, as Smart Hub and phone
  // remotes use) to open an app by its store ID. Only used when
  // config.smartHubLaunch is on (older TVs).
  function smartHubLaunch(storeId) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.timeout = 5000;
      x.open('POST', 'http://127.0.0.1:8001/api/v2/applications/' + encodeURIComponent(storeId));
      x.onload = function () { if (x.status === 200) resolve('smarthub'); else reject(new Error('launcher HTTP ' + x.status)); };
      x.onerror = x.ontimeout = function () { reject(new Error('launcher unreachable')); };
      x.send();
    });
  }

  // Opens an installed app: through Samsung's launcher when a store ID is
  // given, else (or if that fails) launch(), then an app-control launch.
  P.launchApp = function (id, storeId) {
    if (!tz) return previewLaunch(id);
    if (storeId) return smartHubLaunch(storeId).catch(function () { return P.launchApp(id); });
    return new Promise(function (resolve, reject) {
      function viaAppControl(firstError) {
        try {
          tz.application.launchAppControl(
            new tz.ApplicationControl('http://tizen.org/appcontrol/operation/default', null, null, null, null),
            id, function () { resolve('appcontrol'); }, function (e) { reject(e || firstError); });
        } catch (e) { reject(e); }
      }
      try {
        tz.application.launch(id, function () { resolve('launch'); }, viaAppControl);
      } catch (e) { viaAppControl(e); }
    });
  };

  function normalizeUrl(raw) {
    var url = String(raw || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/\//, '');
    return url;
  }

  // Website shortcuts open in the TV's own browser ("Internet"). The explicit
  // org.tizen.browser request is the form Samsung's url_launcher tested on
  // Tizen 7 to 10; the implicit request and a plain browser launch are the
  // fallbacks (the last one loses the address and shows the browser's home).
  P.openUrl = function (raw) {
    var url = normalizeUrl(raw);
    if (!tz) return previewLaunch(url);
    return new Promise(function (resolve, reject) {
      function send(appId, next) {
        try {
          tz.application.launchAppControl(new tz.ApplicationControl(VIEW, url, null, null, null), appId,
            function () { resolve('view'); }, next);
        } catch (e) { next(e); }
      }
      send('org.tizen.browser', function () {
        send(null, function () {
          try { tz.application.launch('org.tizen.browser', function () { resolve('browser-home'); }, reject); } catch (e) { reject(e); }
        });
      });
    });
  };

  var youtubeId = null;
  P.setYouTubeId = function (id) { youtubeId = id || null; };
  function findYouTube() {
    if (youtubeId) return youtubeId;
    var ids = ['9Ur5IzDKqV.TizenYouTube', 'com.samsung.tv.cobalt-yt'];
    for (var i = 0; i < ids.length; i++) {
      try { tz.application.getAppInfo(ids[i]); return ids[i]; } catch (e) { /* next */ }
    }
    return null;
  }

  // YouTube shortcuts: an app-control 'view' request to the YouTube app, never
  // the browser and never an embedded player. mode: 'payload' sends Samsung's
  // documented deep-link carrier PAYLOAD {"values":"v=ID&list=..&t=.."};
  // 'uri' sends https://www.youtube.com/watch?v=ID; 'both' sends both.
  // If YouTube refuses the request it is opened on its home screen instead.
  P.openYouTube = function (link, mode) {
    var Y = window.GHYouTube;
    var p = { videoId: link.videoId || null, playlistId: link.playlistId || null, start: link.start || 0 };
    if (!tz) return previewLaunch('youtube ' + Y.launchValue(p) + ' (' + mode + ')');
    return new Promise(function (resolve, reject) {
      var appId = findYouTube();
      if (!appId) return reject(new Error('YouTube is not installed'));
      var values = Y.launchValue(p);
      var uri = Y.canonicalUrl(p);
      var data = mode === 'uri' ? null : [new tz.ApplicationControlData('PAYLOAD', [JSON.stringify({ values: values })])];
      function plain() {
        try { tz.application.launch(appId, function () { resolve('youtube-home'); }, reject); } catch (e) { reject(e); }
      }
      try {
        var ctl = new tz.ApplicationControl(VIEW, mode === 'payload' ? null : uri, null, null, data);
        tz.application.launchAppControl(ctl, appId, function () { resolve('deep-link'); }, plain);
      } catch (e) { plain(); }
    });
  };

  // Switches the TV to HDMI port n, then opens Samsung's TV viewer so the
  // input fills the screen (Arn0's 'switch+viewer', ported from its inputs.js).
  // n is 'TV' for the antenna (Live TV). If the TV does not report a TV source,
  // the viewer alone is opened, which is what Free My TV does for the antenna.
  // Needs the tv.window privilege (public level).
  P.switchInput = function (n) {
    var live = n === 'TV';
    if (!tz) return previewLaunch(live ? 'Live TV' : 'HDMI ' + n);
    return new Promise(function (resolve, reject) {
      try {
        tz.systeminfo.getPropertyValue('VIDEOSOURCE', function (info) {
          var all = (info.connected || []).concat(info.disconnected || []);
          var src = null;
          for (var i = 0; i < all.length; i++) {
            if (live ? all[i].type === 'TV' : (all[i].type === 'HDMI' && all[i].number === n)) { src = all[i]; break; }
          }
          if (!src && live) {
            P.launchApp('org.tizen.tv-viewer').then(function () { resolve('tv-viewer'); }, reject);
            return;
          }
          if (!src) { reject(new Error('HDMI ' + n + ' is not reported by the TV')); return; }
          try {
            tz.tvwindow.setSource(src, function () {
              // The input is already switched; the viewer only makes it full screen.
              P.launchApp('org.tizen.tv-viewer').then(function () { resolve('input'); }, function () { resolve('input'); });
            }, reject, 'MAIN');
          } catch (e) { reject(e); }
        }, reject);
      } catch (e) { reject(e); }
    });
  };

  // Starts this package's web service. If it is already running the request
  // goes to its onRequest, which is harmless.
  P.startService = function () {
    if (!tz) return Promise.resolve('preview');
    return new Promise(function (resolve, reject) {
      function viaLaunch(err) {
        try { tz.application.launch(P.serviceId, function () { resolve('launch'); }, function (e) { reject(e || err); }); } catch (e) { reject(e); }
      }
      try {
        tz.application.launchAppControl(new tz.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
          P.serviceId, function () { resolve('appcontrol'); }, viaLaunch);
      } catch (e) { viaLaunch(e); }
    });
  };

  // Free internal storage, for the + panel. Resolves null when unavailable.
  P.storage = function () {
    if (!tz || !tz.systeminfo) return Promise.resolve(null);
    return new Promise(function (resolve) {
      try {
        tz.systeminfo.getPropertyValue('STORAGE', function (s) {
          var units = (s && s.units) || [];
          var internal = null;
          for (var i = 0; i < units.length; i++) if (units[i].type === 'INTERNAL') { internal = units[i]; break; }
          resolve(internal ? { available: internal.availableCapacity, capacity: internal.capacity } : null);
        }, function () { resolve(null); });
      } catch (e) { resolve(null); }
    });
  };

  GH.platform = P;
}());
