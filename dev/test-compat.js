#!/usr/bin/env node
// Unit tests for app/service/compat.js and the fallback compare in auth.js:
// the Node 4 fallbacks must behave like the built-ins.  Run: node dev/test-compat.js
'use strict';
var path = require('path');
var crypto = require('crypto');
var SVC = path.join(__dirname, '..', 'app', 'service');
var compat = require(path.join(SVC, 'compat.js'));

var fails = 0;
var checks = 0;
function eq(a, b, label) {
  checks++;
  if (a !== b) { fails++; console.log('FAIL ' + label + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
}

// LegacyURL matches WHATWG URL on the fields the service reads.
var KEYS = ['href', 'protocol', 'username', 'password', 'hostname', 'host', 'port', 'pathname', 'search', 'hash', 'origin'];
var urls = [
  ['http://10.0.0.10:8123'],
  ['https://www.example.com/a/b?x=1#h'],
  ['HTTPS://Example.COM:443/'],
  ['http://user:pw@host.com/'],
  ['https://[::1]:8080/p'],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10'],
  ['/favicon.ico', 'https://example.com/a/b'],
  ['//cdn.example.com/i.png', 'https://example.com/'],
  ['icon.png', 'https://example.com/dir/page.html'],
  ['https://other.example/x', 'https://example.com/']
];
urls.forEach(function (c) {
  var real = new URL(c[0], c[1]);
  var legacy = new compat.LegacyURL(c[0], c[1]);
  KEYS.forEach(function (k) { eq(legacy[k], real[k], c.join(' @ ') + ' ' + k); });
});
['notaurl', 'http://', ''].forEach(function (s) {
  var threw = false;
  try { new compat.LegacyURL(s); } catch (e) { threw = true; }   // eslint-disable-line no-new
  eq(threw, true, 'rejects ' + JSON.stringify(s));
});

eq(compat.fromBase64('aGVsbG8=').toString(), 'hello', 'fromBase64');

// auth.js without crypto.timingSafeEqual (Node 4).
function loadAuth() {
  delete require.cache[require.resolve(path.join(SVC, 'auth.js'))];
  return require(path.join(SVC, 'auth.js'));
}
var saved = crypto.timingSafeEqual;
crypto.timingSafeEqual = undefined;
try {
  var auth = loadAuth();
  eq(auth.timingSafeEqualStr('same-key', 'same-key'), true, 'fallback equal');
  eq(auth.timingSafeEqualStr('same-key', 'same-kez'), false, 'fallback different');
  eq(auth.timingSafeEqualStr('same-key', 'same-key2'), false, 'fallback longer');
} finally {
  crypto.timingSafeEqual = saved;
  loadAuth();
}

auth = loadAuth();
auth.hashPassword('correct horse 12', 1000, false).then(function (rec) {
  crypto.timingSafeEqual = undefined;
  return Promise.all([
    auth.verifyPassword('correct horse 12', rec),
    auth.verifyPassword('wrong horse 12', rec)
  ]);
}).then(function (r) {
  crypto.timingSafeEqual = saved;
  eq(r[0], true, 'fallback verify right password');
  eq(r[1], false, 'fallback verify wrong password');
  console.log(checks + ' checks, ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
}, function (e) {
  crypto.timingSafeEqual = saved;
  console.log('FAIL verifyPassword: ' + (e && e.stack));
  process.exit(1);
});
