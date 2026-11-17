#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(__dirname + '/../app/js/photos.js', 'utf8');
function setup(responses) {
  const calls = [];
  const GH = { request: (...args) => { calls.push(args); return Promise.resolve(responses.shift() || {status:0}); } };
  vm.runInNewContext(source, {window:{GH}, URL, Promise});
  return {GH, calls};
}
(async () => {
  const {GH} = setup([]);
  const parse = data => GH.photos.parse({status:200,data}, 'http://nas/photos/manifest.json?rev=1', true);
  const p = parse([null, 3, {}, {file:123}, {file:'javascript:alert(1)'}, {file:'data:image/png;base64,x'}, {file:'file:///a.jpg'}, {file:'a.svg'}, {file:'../coast.jpg', title:'<script>x</script>'}, {src:'https://other.test/b.png?x=1'}]);
  assert.equal(p.length, 2);
  assert.equal(p[0].url, 'http://nas/coast.jpg');
  assert.equal(p[0].credit, '<script>x</script>'); // text only; never HTML
  assert.equal(p[1].url, 'https://other.test/b.png?x=1');
  assert.equal(parse({photos:[{path:'a.jpg'}]}).length, 1);
  assert.equal(parse({remoteManifest:'http://other/list.json'}).length, 0);
  for (const response of [{status:0}, {status:200,data:{photos:'bad'}}, {status:200,data:[]}]) {
    const s = setup([{status:200,data:[{file:'local.jpg'}]}, response]);
    const list = await s.GH.photos.load({photos:{remoteManifest:'http://nas/list.json'}});
    assert.equal(list.length, 1);
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1][3], 6000);
  }
  assert.equal(parse([{file:'a.jpg',licence:'CC0 1.0 Universal Public Domain Dedication'}])[0].credit, 'CC0');
  const off = setup([{status:200,data:[]}]);
  assert.equal((await off.GH.photos.load({photos:{remoteManifest:''}})).length, 0);
  assert.equal(off.calls.length, 1); // no preview fallback on TV
  const on = setup([{status:200,data:[{file:'local.jpg'}]}, {status:200,data:[{file:'a.jpg'}]}]);
  const list = await on.GH.photos.load({photos:{remoteManifest:'http://nas/list.json'}});
  assert.equal(list.length, 2);
  assert.notEqual(list[0].key, list[1].key);
  console.log('Photo manifest checks passed');
})().catch(e => { console.error(e); process.exitCode=1; });
