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
  const cfg = {photos:{matchSky:true}};
  const at = (month, day, hour) => new Date(2026,month-1,day,hour);
  const all = [
    {key:'plain'}, {key:'day',time:['day']}, {key:'night',time:['night']},
    {key:'xmas',holiday:'christmas'}, {key:'july',month:[7],time:['day']},
    {key:'both',month:[7],holiday:'christmas'}
  ];
  assert.equal(GH.photos.match(all,{photos:{matchSky:false}},at(7,1,12)).length,6);
  assert.deepEqual(Array.from(GH.photos.match(all,cfg,at(7,1,12)),p=>p.key),['plain','day','night','july']);
  assert(!GH.photos.match(all,cfg,at(12,1,12)).some(p=>p.key==='july'||p.key==='both'));
  assert(GH.photos.match(all,cfg,at(12,25,12)).some(p=>p.key==='xmas'));
  assert(!GH.photos.match(all,cfg,at(12,26,12)).some(p=>p.key==='xmas'));
  for (const [date,want] of [[at(10,3,12),'halloween'],[at(11,1,12),'thanksgiving'],[at(11,26,12),'thanksgiving'],[at(11,27,12),'christmas'],[at(12,26,12),'newyear'],[at(1,1,12),null]]) {
    assert.equal(GH.photos.holidayNow(date,{}),want);
  }
  for (const [hour,time] of [[6.5,'dawn'],[9,'day'],[18,'golden'],[22,'night']]) {
    const date=at(7,1,Math.floor(hour)); date.setMinutes(hour%1*60);
    assert.equal(GH.photos.skyMood(date).time,time);
  }
  GH.sky={code:61};
  assert.equal(GH.photos.skyMood(at(7,1,12)).weather,'rain');
  const pool = Array.from({length:4},(_,i)=>({key:'rain'+i,time:['day'],weather:['rain']})).concat([{key:'night',time:['night']}]);
  assert.equal(GH.photos.match(pool,cfg,at(7,1,12)).length,4);
  GH.sky={code:45};
  assert.equal(GH.photos.match(pool,cfg,at(7,1,12)).length,4); // time fallback
  const tag=GH.photos.parse({status:200,data:[{file:'a.jpg',time:'bad',weather:['rain','bad'],month:[0,12,13]}]},'wallpapers/',false)[0];
  assert.equal(tag.time,null); assert.equal(tag.weather.length,1); assert.equal(tag.month[0],12);
  console.log('Photo manifest and sky selection checks passed');
})().catch(e => { console.error(e); process.exitCode=1; });
