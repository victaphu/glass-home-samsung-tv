// Glass Home service - fallbacks for older TV Node runtimes.
// A 2020 Q70T (Tizen 5.5) runs the service on Node 4.4.3, which has no
// url.URL, no Buffer.from(string, encoding) and no crypto.timingSafeEqual.
// Each export uses the built-in when it exists.
'use strict';
var urlmod = require('url');

// Buffer from a base64 string.
function fromBase64(s) {
  if (typeof Buffer.alloc === 'function') return Buffer.from(String(s), 'base64');
  return new Buffer(String(s), 'base64');   // eslint-disable-line no-buffer-constructor
}

// The subset of WHATWG URL the service reads: href, protocol, username,
// password, hostname, host, port, pathname, search, hash, origin.
function LegacyURL(input, base) {
  var s = String(input);
  if (base !== undefined) s = urlmod.resolve(String(base && base.href ? base.href : base), s);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) throw new TypeError('Invalid URL: ' + input);
  var p = urlmod.parse(s);
  if (!p.protocol) throw new TypeError('Invalid URL: ' + input);
  var special = /^(https?|ftp|wss?):$/.test(p.protocol);
  if (special && !p.hostname) throw new TypeError('Invalid URL: ' + input);
  var auth = (p.auth || '').split(':');
  this.protocol = p.protocol.toLowerCase();
  this.username = p.auth ? auth[0] : '';
  this.password = p.auth && auth.length > 1 ? auth.slice(1).join(':') : '';
  var hn = (p.hostname || '').toLowerCase();
  this.hostname = hn.indexOf(':') >= 0 ? '[' + hn + ']' : hn;
  var defPort = { 'http:': '80', 'https:': '443', 'ftp:': '21', 'ws:': '80', 'wss:': '443' }[this.protocol];
  this.port = p.port && p.port !== defPort ? p.port : '';
  this.host = this.hostname + (this.port ? ':' + this.port : '');
  this.pathname = p.pathname || (special ? '/' : '');
  this.search = p.search && p.search !== '?' ? p.search : '';
  this.hash = p.hash && p.hash !== '#' ? p.hash : '';
  this.origin = special ? this.protocol + '//' + this.host : 'null';
  var cred = this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '';
  this.href = this.protocol + (special || p.slashes ? '//' : '') + cred + this.host + this.pathname + this.search + this.hash;
}
LegacyURL.prototype.toString = function () { return this.href; };

module.exports = {
  URL: typeof urlmod.URL === 'function' ? urlmod.URL : LegacyURL,
  LegacyURL: LegacyURL,
  fromBase64: fromBase64
};
