// Dock choices in app storage. A successful response follows an atomic write,
// fsync and read-back; the browser cache is not the authoritative copy.
'use strict';
var fs = require('fs');

function list(value, pattern, limit) {
  if (!Array.isArray(value) || value.length > limit) throw new Error('bad preferences');
  var seen = Object.create(null);
  return value.filter(function (s) {
    if (typeof s !== 'string' || !pattern.test(s)) throw new Error('bad preferences');
    if (seen[s]) return false;
    seen[s] = true;
    return true;
  });
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad preferences');
  return {
    selected: value.selected === null ? null : list(value.selected, /^[A-Za-z0-9_.-]{1,120}$/, 100),
    hidden: list(value.hidden, /^[A-Za-z0-9_.:-]{1,160}$/, 200)
  };
}

function read(file) {
  var data;
  try { data = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return validate(JSON.parse(data));
}

function write(file, value) {
  var prefs = validate(value);
  var data = JSON.stringify(prefs);
  var tmp = file + '.tmp';
  var fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 384); // 0600
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    if (fs.readFileSync(file, 'utf8') !== data) throw new Error('preferences read-back failed');
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { /* renamed or never created */ }
  }
  return prefs;
}

module.exports = { validate: validate, read: read, write: write };
