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
  GH.photos = { parse: parse, load: load };
}());
