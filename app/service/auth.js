// Glass Home service - passwords, sessions and login throttling.
// Node 12 API only: crypto.pbkdf2, randomBytes, timingSafeEqual, createHash
// (timingSafeEqual has a fallback for Node 4, see safeEqual).
'use strict';
var crypto = require('crypto');
var WORDS = require('./words.js');
var compat = require('./compat.js');

var KEY_LEN = 32;
var MAX_PASSWORD_LEN = 256;

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes) { return b64url(crypto.randomBytes(bytes || 32)); }
function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Unbiased random integer in [0, n).
function randomInt(n) {
  var limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    var x = crypto.randomBytes(4).readUInt32BE(0);
    if (x < limit) return x % n;
  }
}

// "maple-otter-sky-47": three different words and two digits.
function generatePassword() {
  var picked = [];
  while (picked.length < 3) {
    var w = WORDS[randomInt(WORDS.length)];
    if (picked.indexOf(w) < 0) picked.push(w);
  }
  return picked.join('-') + '-' + String(10 + randomInt(90));
}

// Generated passwords are compared case-insensitively and with any separator
// (space, dot, underscore or dash), because phones capitalise and autocorrect.
// Passwords the owner types himself are compared exactly.
function canonicalGenerated(pw) {
  return String(pw).trim().toLowerCase().replace(/[\s._\u2013\u2014-]+/g, '-');
}

// Constant-time compare of two equal-length buffers. Some TV Node runtimes
// (a 2020 Q70T on Tizen 5.5) have no crypto.timingSafeEqual.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  if (typeof crypto.timingSafeEqual === 'function') return crypto.timingSafeEqual(a, b);
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function timingSafeEqualStr(a, b) {
  var ha = crypto.createHash('sha256').update(String(a)).digest();
  var hb = crypto.createHash('sha256').update(String(b)).digest();
  return safeEqual(ha, hb) && String(a).length === String(b).length;
}

function hashPassword(plain, iterations, generated) {
  return new Promise(function (resolve, reject) {
    var salt = crypto.randomBytes(16);
    var input = generated ? canonicalGenerated(plain) : String(plain);
    crypto.pbkdf2(input, salt, iterations, KEY_LEN, 'sha256', function (err, key) {
      if (err) return reject(err);
      resolve({
        alg: 'pbkdf2-sha256',
        iter: iterations,
        salt: salt.toString('base64'),
        hash: key.toString('base64'),
        generated: !!generated,
        id: randomHex(8),
        changedAt: Date.now()
      });
    });
  });
}

function verifyPassword(attempt, rec) {
  return new Promise(function (resolve, reject) {
    if (!rec || rec.alg !== 'pbkdf2-sha256') return resolve(false);
    var s = String(attempt == null ? '' : attempt);
    if (!s || s.length > MAX_PASSWORD_LEN) return resolve(false);
    var input = rec.generated ? canonicalGenerated(s) : s;
    crypto.pbkdf2(input, compat.fromBase64(rec.salt), rec.iter, KEY_LEN, 'sha256', function (err, key) {
      if (err) return reject(err);
      var expected = compat.fromBase64(rec.hash);
      resolve(safeEqual(key, expected));
    });
  });
}

// Login throttling.
//   Per address: `failures` wrong passwords within `windowMs` lock that address
//   out for `lockMs`. While locked, no password is checked at all.
//   Global: every attempt is serialised (one PBKDF2 at a time), and recent
//   failures from anywhere add a growing delay before the next check.
//   Fair queue: at most `maxQueue` checks wait or run at once, and an attempt
//   is refused (BUSY) before it takes a place when its address
//     - already has `perIp` checks waiting or running, or
//     - is locked, or has as many checks pending as it has tries left (they
//       could lock it, so a further one could never be checked), or
//     - wants one of the last `reserve` places but has a check pending or a
//       recent wrong password (those places are kept for another device).
//   So a burst of guesses from one device can neither fill the queue nor keep
//   the owner's phone from signing in.
function Limiter(opts) {
  opts = opts || {};
  this.failures = opts.failures || 5;
  this.lockMs = opts.lockMs || 5 * 60 * 1000;
  this.windowMs = opts.windowMs || 15 * 60 * 1000;
  this.globalWindowMs = opts.globalWindowMs || 10 * 60 * 1000;
  this.globalStepMs = opts.globalStepMs || 400;
  this.globalMaxMs = opts.globalMaxMs || 8000;
  this.maxQueue = opts.maxQueue || 20;
  this.perIp = opts.perIp || 2;
  this.reserve = opts.reserve == null ? 1 : opts.reserve;
  this.byIp = new Map();
  this.inflight = new Map();          // address -> checks waiting or running
  this.globalFails = [];
  this.tail = Promise.resolve();
  this.queued = 0;
}

// The record for `ip` as it stands now. A fresh one if it has none or its lock
// or failure window has passed; only fail() stores records, so addresses that
// never got a password wrong take no memory.
Limiter.prototype._peek = function (ip) {
  var now = Date.now();
  var r = this.byIp.get(ip);
  if (r && r.lockedUntil && r.lockedUntil <= now) r = null;            // lock served
  if (r && !r.lockedUntil && now - r.first > this.windowMs) r = null;  // old failures forgotten
  return r || { count: 0, first: now, lockedUntil: 0 };
};

Limiter.prototype._rec = function (ip) {
  var r = this._peek(ip);
  if (this.byIp.get(ip) !== r) this.byIp.set(ip, r);
  return r;
};

Limiter.prototype.status = function (ip) {
  var r = this._peek(ip);
  var now = Date.now();
  if (r.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((r.lockedUntil - now) / 1000) };
  return { locked: false, remaining: this.failures - r.count };
};

Limiter.prototype.fail = function (ip) {
  var now = Date.now();
  var r = this._rec(ip);
  r.count += 1;
  this.globalFails.push(now);
  if (r.count >= this.failures) {
    r.lockedUntil = now + this.lockMs;
    return { locked: true, retryAfter: Math.ceil(this.lockMs / 1000) };
  }
  return { locked: false, remaining: this.failures - r.count };
};

Limiter.prototype.success = function (ip) { this.byIp.delete(ip); };

Limiter.prototype.globalDelay = function () {
  var cutoff = Date.now() - this.globalWindowMs;
  while (this.globalFails.length && this.globalFails[0] < cutoff) this.globalFails.shift();
  var n = this.globalFails.length;
  if (n <= 2) return 0;
  return Math.min(this.globalMaxMs, (n - 2) * this.globalStepMs);
};

// Whether `ip` may queue a password check now (see Limiter): null if it may,
// otherwise an Error with code 'BUSY' and a `reason`.
Limiter.prototype.admit = function (ip) {
  var r = this._peek(ip);
  var mine = this.inflight.get(ip) || 0;
  var free = this.maxQueue - this.queued;
  var reason = null;
  if (mine >= this.perIp) reason = 'address-busy';
  else if (r.count + mine >= this.failures) reason = 'address-limit';
  else if (free <= 0) reason = 'queue-full';
  else if (free <= this.reserve && (mine > 0 || r.count > 0)) reason = 'queue-reserved';
  if (!reason) return null;
  return Object.assign(new Error('busy'), { code: 'BUSY', reason: reason });
};

// Runs fn() after every earlier attempt has finished (a one-at-a-time queue).
// Rejects at once with the BUSY error if `ip` is not admitted.
Limiter.prototype.serial = function (ip, fn) {
  var self = this;
  var refused = this.admit(ip);
  if (refused) return Promise.reject(refused);
  this.queued += 1;
  this.inflight.set(ip, (this.inflight.get(ip) || 0) + 1);
  function release() {
    self.queued -= 1;
    var left = (self.inflight.get(ip) || 1) - 1;
    if (left > 0) self.inflight.set(ip, left);
    else self.inflight.delete(ip);
  }
  var run = this.tail.then(function () { return fn(); });
  this.tail = run.then(function () {}, function () {});
  return run.then(function (v) { release(); return v; }, function (e) { release(); throw e; });
};

// Housekeeping so the map cannot grow without bound.
Limiter.prototype.sweep = function () {
  var self = this;
  var now = Date.now();
  this.byIp.forEach(function (r, ip) {
    if ((r.lockedUntil && r.lockedUntil <= now) || (!r.lockedUntil && now - r.first > self.windowMs)) self.byIp.delete(ip);
  });
  this.globalDelay();
};

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms)); });
}

module.exports = {
  b64url: b64url,
  randomToken: randomToken,
  randomHex: randomHex,
  sha256hex: sha256hex,
  generatePassword: generatePassword,
  canonicalGenerated: canonicalGenerated,
  timingSafeEqualStr: timingSafeEqualStr,
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  Limiter: Limiter,
  delay: delay,
  MAX_PASSWORD_LEN: MAX_PASSWORD_LEN
};
