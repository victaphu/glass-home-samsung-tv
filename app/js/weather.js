/*
 * Glass Home - weather under the clock: the temperature now, today's high and
 * low, and the next 7 days.
 *
 * Data comes from Open-Meteo (free, no account or key, no tracking; data under
 * CC BY 4.0, credited in the card). The TV fetches it directly every 30
 * minutes. The last good answer is kept in localStorage, so the card appears
 * at once after a restart and survives short outages. Nothing from the network
 * is inserted as HTML: numbers are rounded, labels come from the table below,
 * and the icons are drawn here.
 *
 * Preview (desktop browser): add ?wx=mock to use built-in sample data.
 */
(function () {
  'use strict';
  var GH = window.GH || {};
  var cfg = GH.config && GH.config.weather;
  var root = document.getElementById('weather');
  var mockWx = !!(GH.config && GH.config.preview && GH.query && GH.query.wx === 'mock');
  // Off until a location is set in config.js (?wx=mock in preview shows sample data).
  if (!cfg || !root) return;
  if (!mockWx && (cfg.enabled === false || (!cfg.latitude && !cfg.longitude))) return;

  var FAHRENHEIT = cfg.temperatureUnit === 'fahrenheit';
  var KEY = 'gh.weather.v1' + (FAHRENHEIT ? '.f' : '');   // a unit change never shows the old unit's cache
  var HIDE_AFTER = 12 * 3600 * 1000;    // older than this: hide rather than mislead
  var NOW_STALE = 3 * 3600 * 1000;      // older than this: drop the "now" temperature
  var REFRESH = cfg.refreshMs || 30 * 60 * 1000;
  var mock = !!(GH.config.preview && GH.query && GH.query.wx === 'mock');
  var last = null;
  var timer = null;
  var uid = 0;

  var dayFmt = null;
  try { dayFmt = new Intl.DateTimeFormat(GH.config.locale || undefined, { weekday: 'short' }); } catch (e) { /* fallback below */ }
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // WMO weather codes used by Open-Meteo -> [day label, night label, icon]
  var CODES = {
    0: ['Sunny', 'Clear', 'clear'],
    1: ['Mostly sunny', 'Mostly clear', 'clear'],
    2: ['Partly cloudy', 'Partly cloudy', 'partly'],
    3: ['Cloudy', 'Cloudy', 'cloud'],
    45: ['Fog', 'Fog', 'fog'],
    48: ['Fog', 'Fog', 'fog'],
    51: ['Light drizzle', 'Light drizzle', 'drizzle'],
    53: ['Drizzle', 'Drizzle', 'drizzle'],
    55: ['Drizzle', 'Drizzle', 'drizzle'],
    56: ['Freezing drizzle', 'Freezing drizzle', 'drizzle'],
    57: ['Freezing drizzle', 'Freezing drizzle', 'drizzle'],
    61: ['Light rain', 'Light rain', 'rain'],
    63: ['Rain', 'Rain', 'rain'],
    65: ['Heavy rain', 'Heavy rain', 'rain'],
    66: ['Freezing rain', 'Freezing rain', 'rain'],
    67: ['Freezing rain', 'Freezing rain', 'rain'],
    71: ['Light snow', 'Light snow', 'snow'],
    73: ['Snow', 'Snow', 'snow'],
    75: ['Heavy snow', 'Heavy snow', 'snow'],
    77: ['Snow', 'Snow', 'snow'],
    80: ['Showers', 'Showers', 'showers'],
    81: ['Showers', 'Showers', 'showers'],
    82: ['Heavy showers', 'Heavy showers', 'rain'],
    85: ['Snow showers', 'Snow showers', 'snow'],
    86: ['Snow showers', 'Snow showers', 'snow'],
    95: ['Storms', 'Storms', 'storm'],
    96: ['Storms with hail', 'Storms with hail', 'storm'],
    99: ['Storms with hail', 'Storms with hail', 'storm']
  };

  // ---------- icons (64 x 64, filled, like Apple's multicolour symbols) ----------
  var SUN = '#FFCC48';
  var MOON = '#F2EDD5';
  var RAIN = '#68C4FF';
  var BOLT = '#FFD84D';

  function n(v) { return String(Math.round(v * 100) / 100); }

  function sunShape(cx, cy, r, r1, r2) {
    var rays = '';
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4;
      rays += '<line x1="' + n(cx + r1 * Math.cos(a)) + '" y1="' + n(cy + r1 * Math.sin(a)) +
        '" x2="' + n(cx + r2 * Math.cos(a)) + '" y2="' + n(cy + r2 * Math.sin(a)) + '"/>';
    }
    return '<g stroke="' + SUN + '" stroke-width="3.6" stroke-linecap="round">' + rays + '</g>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + SUN + '"/>';
  }

  function moonShape(cx, cy, r) {
    var id = 'wxm' + (++uid);
    return '<defs><mask id="' + id + '"><rect width="64" height="64" fill="#fff"/>' +
      '<circle cx="' + n(cx + r * 0.6) + '" cy="' + n(cy - r * 0.5) + '" r="' + n(r * 0.82) + '" fill="#000"/></mask></defs>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + MOON + '" mask="url(#' + id + ')"/>';
  }

  // A cloud spanning x 14-54, y 18-48 before the shift.
  function cloudShape(dx, dy) {
    return '<g fill="#fff" transform="translate(' + dx + ' ' + dy + ')">' +
      '<circle cx="24" cy="38" r="10"/><circle cx="34" cy="31" r="13"/><circle cx="45" cy="39" r="9"/>' +
      '<rect x="24" y="38" width="21" height="10"/></g>';
  }

  function strokes(color, width, segs) {
    var s = '';
    for (var i = 0; i < segs.length; i++) {
      var p = segs[i];
      s += '<line x1="' + p[0] + '" y1="' + p[1] + '" x2="' + p[2] + '" y2="' + p[3] + '"/>';
    }
    return '<g stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round">' + s + '</g>';
  }

  function dots(color, r, pts) {
    var s = '';
    for (var i = 0; i < pts.length; i++) s += '<circle cx="' + pts[i][0] + '" cy="' + pts[i][1] + '" r="' + r + '"/>';
    return '<g fill="' + color + '">' + s + '</g>';
  }

  function iconSvg(kind, night) {
    var b;
    switch (kind) {
      case 'clear':
        b = night ? moonShape(31, 33, 17) : sunShape(32, 32, 11, 17, 23);
        break;
      case 'partly':
        b = (night ? moonShape(22, 22, 11) : sunShape(23, 22, 8, 12.5, 17)) + cloudShape(4, 8);
        break;
      case 'fog':
        b = strokes('rgba(255,255,255,0.92)', 4.5, [[12, 22, 46, 22], [18, 32, 52, 32], [12, 42, 44, 42], [22, 52, 50, 52]]);
        break;
      case 'drizzle':
        b = cloudShape(-2, -7) + strokes(RAIN, 4, [[22, 46, 21, 49], [32, 46, 31, 49], [42, 46, 41, 49], [27, 53, 26, 56], [37, 53, 36, 56]]);
        break;
      case 'rain':
        b = cloudShape(-2, -7) + strokes(RAIN, 4, [[23, 46, 20, 56], [32, 46, 29, 56], [41, 46, 38, 56]]);
        break;
      case 'showers':
        b = (night ? moonShape(19, 17, 9) : sunShape(19, 17, 6.5, 10.5, 14.5)) + cloudShape(2, -3) +
          strokes(RAIN, 4, [[28, 50, 25, 59], [39, 50, 36, 59]]);
        break;
      case 'storm':
        b = cloudShape(-2, -8) + '<polygon points="34,38 26,51 32,51 28,62 41,47 35,47 39,38" fill="' + BOLT + '"/>';
        break;
      case 'snow':
        b = cloudShape(-2, -7) + dots('#fff', 2.8, [[22, 49], [32, 53], [42, 49], [27, 58], [37, 58]]);
        break;
      default:
        b = cloudShape(-2, -1);
    }
    return '<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">' + b + '</svg>';
  }

  // ---------- data ----------
  function readCache() {
    try { return JSON.parse(window.localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function writeCache(rec) {
    try { window.localStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) { /* storage full or off */ }
  }

  function num(v) { return typeof v === 'number' && isFinite(v); }
  function deg(v) { return (Math.round(v) || 0) + '°'; }

  function valid(j) {
    if (!j || !j.current || !j.daily) return false;
    var d = j.daily;
    if (!d.time || !d.time.length || !d.weather_code || !d.temperature_2m_max || !d.temperature_2m_min) return false;
    for (var i = 0; i < d.time.length; i++) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.time[i]))) return false;
    }
    return num(j.current.temperature_2m);
  }

  // Parse offset-free Open-Meteo times as local wall-clock times on old TVs.
  function localTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
  }

  function shareSky(sky) {
    var old = GH.sky;
    GH.sky = sky;
    if (JSON.stringify(old) !== JSON.stringify(sky)) {
      try { document.dispatchEvent(new CustomEvent('gh-sky')); } catch (e) { /* timer also updates */ }
    }
  }

  function localDay(dt) {
    return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
  }

  function weekday(ymd) {
    var p = ymd.split('-');
    var dt = new Date(+p[0], +p[1] - 1, +p[2]);
    try { if (dayFmt) return dayFmt.format(dt).replace(/\.$/, ''); } catch (e) { /* fall through */ }
    return DAYS[dt.getDay()];
  }

  function info(code) { return CODES[code] || ['', '', 'cloud']; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    var rec = last;
    var age = rec ? Date.now() - rec.at : Infinity;
    if (!rec || !valid(rec.data) || age > HIDE_AFTER) { shareSky(null); root.classList.remove('on'); return; }
    var j = rec.data;
    var d = j.daily;
    var i0 = d.time.indexOf(localDay(new Date()));
    if (i0 < 0) { shareSky(null); root.classList.remove('on'); return; }

    // Now: icon, temperature, condition, today's high and low.
    var c = j.current;
    var night = c.is_day === 0;
    var nowCode = num(c.weather_code) ? c.weather_code : d.weather_code[i0];
    var nowInfo = info(nowCode);
    var showNow = age <= NOW_STALE;
    if (GH.config.photos && GH.config.photos.matchSky) shareSky({
      code: showNow ? nowCode : null,
      sunrise: d.sunrise ? localTime(d.sunrise[i0]) : null,
      sunset: d.sunset ? localTime(d.sunset[i0]) : null
    });
    document.getElementById('wx-now-icon').innerHTML = iconSvg(showNow ? nowInfo[2] : info(d.weather_code[i0])[2], showNow && night);
    document.getElementById('wx-now-temp').textContent = showNow ? deg(c.temperature_2m) : '';
    var parts = [];
    var label = showNow ? nowInfo[night ? 1 : 0] : info(d.weather_code[i0])[0];
    if (label) parts.push(label);
    if (num(d.temperature_2m_max[i0]) && num(d.temperature_2m_min[i0])) {
      parts.push('H ' + deg(d.temperature_2m_max[i0]) + '  L ' + deg(d.temperature_2m_min[i0]));
    }
    document.getElementById('wx-now-text').textContent = parts.join('  ·  ');

    // The next 7 days.
    var row = document.getElementById('wx-days');
    row.textContent = '';
    var rain = d.precipitation_probability_max || [];
    for (var i = i0 + 1; i < d.time.length && i <= i0 + 7; i++) {
      var day = el('div', 'wx-day');
      day.appendChild(el('div', 'wx-dname', weekday(String(d.time[i]))));
      var ic = el('div', 'wx-icon');
      ic.innerHTML = iconSvg(info(d.weather_code[i])[2], false);
      day.appendChild(ic);
      day.appendChild(el('div', 'wx-hi', num(d.temperature_2m_max[i]) ? deg(d.temperature_2m_max[i]) : '–'));
      day.appendChild(el('div', 'wx-lo', num(d.temperature_2m_min[i]) ? deg(d.temperature_2m_min[i]) : ''));
      day.appendChild(el('div', 'wx-rain', num(rain[i]) && rain[i] >= 20 ? Math.round(rain[i]) + '%' : ''));
      row.appendChild(day);
    }
    document.getElementById('wx-place').textContent = cfg.place || '';
    root.classList.toggle('stale-now', !showNow);
    root.classList.add('on');
  }

  function url() {
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(cfg.latitude) +
      '&longitude=' + encodeURIComponent(cfg.longitude) +
      '&current=temperature_2m,weather_code,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      (GH.config.photos && GH.config.photos.matchSky ? ',sunrise,sunset' : '') +
      (FAHRENHEIT ? '&temperature_unit=fahrenheit' : '') +
      '&timezone=' + encodeURIComponent(cfg.timezone || 'auto') + '&forecast_days=8';
  }

  function sample() {
    var codes = [2, 61, 80, 3, 1, 0, 2, 61];
    var hi = [21, 18, 17, 19, 22, 24, 23, 20];
    var lo = [12, 11, 10, 9, 11, 13, 14, 12];
    var rain = [10, 70, 80, 30, 10, 0, 20, 60];
    var t = [];
    var base = new Date();
    for (var i = 0; i < 8; i++) t.push(localDay(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
    return {
      current: { temperature_2m: 18.0, weather_code: 2, is_day: 1 },
      daily: { time: t, weather_code: codes, temperature_2m_max: hi, temperature_2m_min: lo, precipitation_probability_max: rain }
    };
  }

  var loading = false;
  function load() {
    if (mock) { last = { at: Date.now(), data: sample() }; render(); return; }
    if (loading || !window.fetch) { render(); return; }
    loading = true;
    var ctrl = window.AbortController ? new window.AbortController() : null;
    var guard = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    var opts = { cache: 'no-store', credentials: 'omit' };
    if (ctrl) opts.signal = ctrl.signal;
    window.fetch(url(), opts)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!valid(j)) throw new Error('unexpected weather data');
        last = { at: Date.now(), data: j };
        writeCache(last);
      })
      .catch(function () { /* keep the cached forecast while it is recent */ })
      .then(function () {
        loading = false;
        if (guard) clearTimeout(guard);
        render();
      });
  }

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(load, REFRESH);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearInterval(timer); timer = null; return; }
    render();
    if (!last || Date.now() - last.at > 10 * 60 * 1000) load();
    startTimer();
  });

  last = readCache();
  render();
  load();
  startTimer();
}());
