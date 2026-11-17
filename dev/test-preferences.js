#!/usr/bin/env node
'use strict';
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const src=fs.readFileSync(__dirname+'/../app/js/preferences.js','utf8');
function run(saved,blocked=false) {
  const store = {'gh.preferences.v1': saved};
  const GH={config:{photoIntervalMs:120000,photos:{matchSky:false},ambient:{enabled:true,afterMs:300000},night:{enabled:true,from:'21:30',to:'07:00'},weather:{temperatureUnit:'celsius'}}};
  vm.runInNewContext(src,{window:{GH},localStorage:{getItem:k=>store[k],setItem:(k,v)=>{if(blocked)throw Error();store[k]=v;},removeItem:k=>{if(blocked)throw Error();delete store[k];}}});
  return {GH,store};
}
const bad=run('{broken');assert.equal(bad.GH.config.photoIntervalMs,120000);
const s=run(JSON.stringify({photoSec:60,matchSky:true,screensaverMin:0,unit:'fahrenheit',dimFrom:'99:00',remoteManifest:'http://untrusted'}));
assert.equal(s.GH.config.photoIntervalMs,60000);assert.equal(s.GH.config.photos.matchSky,true);assert.equal(s.GH.config.ambient.enabled,false);assert.equal(s.GH.config.night.from,'21:30');assert.equal(s.GH.config.weather.temperatureUnit,'fahrenheit');assert.equal(s.GH.config.photos.remoteManifest,undefined);
assert(s.GH.preferences.reset());assert.equal(s.store['gh.preferences.v1'],undefined);
assert.equal(run(null,true).GH.preferences.save({photoSec:60}),false);
assert.equal(run(null,true).GH.preferences.reset(),false);
const clean=s.GH.preferences.clean({photoSec:'60',screensaverMin:-1,dim:'true',unit:'kelvin'});assert.equal(Object.keys(clean).length,0);
console.log('Local preference validation checks passed');
