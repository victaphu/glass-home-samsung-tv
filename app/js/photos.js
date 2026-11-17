/* Glass Home - bundled and optional remote photo manifests. Data only. */
(function () {
  'use strict';
  var GH = window.GH;
  function shortLicence(l) {
    var s = String(l || '');
    if (/^CC0/i.test(s) || /public domain dedication/i.test(s)) return 'CC0';
    var m = /(CC BY(?:-[A-Z]{2})*\s*\d\.\d)/i.exec(s);
    if (m) return m[1].toUpperCase();
    if (/public domain/i.test(s)) return 'Public domain';
    return s;
  }

  function tags(value, allowed) {
    if (!Array.isArray(value)) return null;
    var clean = value.filter(function (v) { return allowed.indexOf(v) >= 0; });
    return clean.length ? clean : null;
  }
  function parse(r, base, remote) {
    if (!r || r.status !== 200) return [];
    var list = r.data;
    if (list && !Array.isArray(list)) list = list.photos || list.items || list.wallpapers;
    if (!Array.isArray(list)) return [];
    return list.slice(0, 2000).map(function (w) {
      if (!w || typeof w !== 'object') return null;
      var file = w.file || w.src || w.path;
      if (typeof file !== 'string' || !file || file.length > 4096) return null;
      var url = base + file;
      if (remote) {
        try {
          var u = new URL(file, base);
          if (!/^https?:$/.test(u.protocol) || u.username || u.password ||
              !/\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(u.pathname)) return null;
          url = u.href;
        } catch (e) { return null; }
      }
      function text(v) { return typeof v === 'string' ? v.slice(0, 500) : ''; }
      return {
        key: remote ? 'r:' + url : 'w:' + file,
        url: url,
        credit: [text(w.title), text(w.author), text(w.licence_short || shortLicence(w.licence || w.license))].filter(Boolean).join(' · '),
        time: tags(w.time, ['dawn', 'day', 'golden', 'night']),
        weather: tags(w.weather, ['clear', 'cloudy', 'fog', 'rain']),
        holiday: ['halloween', 'thanksgiving', 'christmas', 'newyear'].indexOf(w.holiday) >= 0 ? w.holiday : null,
        month: tags(w.month, [1,2,3,4,5,6,7,8,9,10,11,12]),
        user: false
      };
    }).filter(Boolean);
  }
  function load(cfg) {
    return GH.request('GET', 'wallpapers/manifest.json', undefined, 4000).then(function (r) {
      var list = parse(r, 'wallpapers/', false);
      if (list.length || !cfg.preview) return list;
      return GH.request('GET', '/preview-assets/manifest.json', undefined, 3000).then(function (r2) {
        return parse(r2, '/preview-assets/', false);
      });
    }).then(function (list) {
      var address = cfg.photos && cfg.photos.remoteManifest;
      if (typeof address !== 'string' || !/^https?:\/\//i.test(address)) return list;
      try {
        var u = new URL(address);
        if (u.username || u.password) return list;
        address = u.href;
      } catch (e) { return list; }
      return GH.request('GET', address, undefined, 6000).then(function (r) {
        return list.concat(parse(r, address, true));
      }, function () { return list; });
    });
  }
  function skyMood(now) {
    var sky = GH.sky || {};
    var t = now.getTime();
    var rise = sky.sunrise;
    var set = sky.sunset;
    if (!rise || !set || new Date(rise).toDateString() !== now.toDateString()) {
      var d = new Date(now);
      d.setHours(7, 0, 0, 0); rise = d.getTime();
      d.setHours(18, 30, 0, 0); set = d.getTime();
    }
    var H = 3600 * 1000;
    var time = t >= rise - 0.75 * H && t < rise + H ? 'dawn'
      : t >= set - 1.5 * H && t < set + 0.5 * H ? 'golden'
      : t >= rise && t < set ? 'day' : 'night';
    var c = sky.code;
    var weather = c == null ? null
      : c <= 2 ? 'clear'
      : c === 45 || c === 48 ? 'fog'
      : (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95 ? 'rain'
      : 'cloudy';
    return { time: time, weather: weather };
  }

  // ---------- holiday photos ----------
  // The four weeks before Halloween, Thanksgiving (4th Thursday of November)
  // and Christmas, and Dec 26-31 for New Year. Where two overlap, the nearer
  // one wins. ?holiday=christmas (or none) overrides it in a preview.
  function holidayNow(now, Q) {
    if (Q.holiday) return Q.holiday === 'none' ? null : Q.holiday;
    var y = now.getFullYear();
    function day(m, d) { return new Date(y, m, d).getTime(); }
    var t = day(now.getMonth(), now.getDate());
    var thanks = 1 + (4 - new Date(y, 10, 1).getDay() + 7) % 7 + 21;   // date in November
    if (t >= day(9, 31 - 28) && t <= day(9, 31)) return 'halloween';
    if (t > day(9, 31) && t >= day(10, thanks - 28) && t <= day(10, thanks)) return 'thanksgiving';
    if (t > day(10, thanks) && t >= day(11, 25 - 28) && t <= day(11, 25)) return 'christmas';
    if (t >= day(11, 26) && t <= day(11, 31)) return 'newyear';
    return null;
  }

  // Tagged photos matching both, else the time alone, else every photo; in a
  // holiday's season its photos join them (by time of day when 3 or more fit),
  // and in each month that month's photos that fit the time of day. Holiday
  // and month photos never show out of season. ?month=12 overrides the month
  // in a preview.
  function matchingPhotos(all, cfg, now) {
    if (!cfg.photos || cfg.photos.matchSky !== true) return all;
    now = now || new Date();
    var Q = cfg.preview ? GH.query || {} : {};
    function has(list, v) { return !!list && list.indexOf(v) >= 0; }
    var regular = all.filter(function (p) { return !p.holiday && !p.month; });
    var h = holidayNow(now, Q);
    var month = /^\d+$/.test(Q.month || '') ? +Q.month : now.getMonth() + 1;
    var festive = h ? all.filter(function (p) { return p.holiday === h && (!p.month || has(p.month, month)); }) : [];
    var monthly = all.filter(function (p) { return !p.holiday && has(p.month, month); });
    var m = skyMood(now);
    var base = regular.filter(function (p) { return (!p.time || has(p.time, m.time)) && (!p.weather || !m.weather || has(p.weather, m.weather)); });
    if (base.length < 3) base = regular.filter(function (p) { return (!p.time || has(p.time, m.time)); });
    if (base.length < 3) base = regular;
    var festiveNow = festive.filter(function (p) { return (!p.time || has(p.time, m.time)); });
    return base.concat(festiveNow.length >= 3 ? festiveNow : festive,
      monthly.filter(function (p) { return (!p.time || has(p.time, m.time)); }));
  }

  GH.photos = { parse: parse, load: load, match: matchingPhotos, skyMood: skyMood, holidayNow: holidayNow };
}());
