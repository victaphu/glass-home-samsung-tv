#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm');
const EventEmitter = require('events');
const root = path.join(__dirname, '..');
const id = 'test.Netflix', other = 'test.Other';
const catalog = { available:true, address:'127.0.0.1', apps:[{appId:id,label:'Netflix'}] };
let checks = 0;
function equal(a,b,why) { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)),b,why);checks++; }
const flush = () => new Promise(resolve => setImmediate(resolve));

function simulated(options = {}) {
  const calls=[],timers=new Map(),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'app/service/vetro-launch.js'),'utf8'), {
    module,Buffer,Date,
    setTimeout:(fn,ms)=>{const t={fn,ms};timers.set(t,true);return t;},clearTimeout:t=>timers.delete(t),
    require:name=>name==='./vetro.js'?{localLanAddresses:()=>['192.168.84.19']}:{request:(opts,respond)=>{
      calls.push(opts);
      if(options.setupError)throw Error('setup');
      const req=new EventEmitter();req.destroy=()=>{if(options.closeError)throw Error('close');};
      req.end=body=>{
        opts.body=body;
        const post=opts.method==='POST';
        const socket=new EventEmitter();socket.connecting=true;req.emit('socket',socket);
        if(options.offline||post&&options.post==='refused'){req.emit('error',Error('refused'));return;}
        if(post&&options.post==='connect-timeout')return;
        socket.emit('connect');
        if(post&&options.post==='timeout')return;
        if(post&&options.post==='disconnect'){req.emit('error',Error('reset'));return;}
        const res=new EventEmitter();res.statusCode=post?(options.status||200):200;respond(res);
        const data=post?(options.body===undefined?JSON.stringify({ok:true,sent:1}):options.body):JSON.stringify({agent:{connected:options.root!==false}});
        res.emit('data',Buffer.from(data));res.emit('end');
      };
      return req;
    }}
  });
  const reader={current:()=>options.catalog===undefined?catalog:options.catalog};
  return { launch:module.exports.createLauncher(reader),calls,timers };
}

function platform({available=true,reply=()=>Promise.resolve(true),smartStatus=200,failNative=false}={}) {
  const calls=[];
  function XHR(){this.open=(method,url)=>{this.url=url;};this.send=()=>{calls.push(['smart',this.url]);this.status=smartStatus;this.onload();};}
  const GH={config:{preview:false,serviceName:'Photos'},vetro:{available},data:{vetroLaunch:appId=>{calls.push(['vetro',appId]);return reply(appId);}}};
  const tizen={application:{
    getCurrentApplication:()=>({appInfo:{packageId:'GlassHome1'}}),
    launch:(appId,ok,fail)=>{calls.push(['native',appId]);if(failNative)fail(Error('native'));else ok();},
    launchAppControl:(ctl,appId,ok)=>{calls.push(['control',appId,ctl.operation,ctl.uri]);ok();}
  },ApplicationControl:function(operation,uri){this.operation=operation;this.uri=uri;},
  systeminfo:{getPropertyValue:(name,ok)=>ok({connected:[{type:'HDMI',number:1}]})},
  tvwindow:{setSource:(src,ok)=>ok()}};
  const window={GH,tizen};
  vm.runInNewContext(fs.readFileSync(path.join(root,'app/js/platform.js'),'utf8'),{window,XMLHttpRequest:XHR,setTimeout,clearTimeout,console});
  return {P:GH.platform,GH,calls};
}

(async()=>{
  for(const [options,outcome] of [
    [{},'accepted'],[{root:false},'fallback'],[{offline:true},'fallback'],
    [{setupError:true},'fallback'],[{post:'refused',closeError:true},'fallback'],
    [{post:'disconnect'},'unknown'],[{status:404},'fallback'],[{status:405},'fallback'],
    [{status:503},'unknown'],[{body:'not-json'},'unknown'],
    [{body:'x'.repeat(65537)},'unknown'],[{body:'{"ok":true,"sent":0}'},'unknown']
  ]) {
    const t=simulated(options);equal((await t.launch(id)).outcome,outcome,JSON.stringify(options).slice(0,80));
    equal(t.calls.filter(x=>x.method==='POST').length,options.root===false||options.offline||options.setupError?0:1,'at most one launch POST');
    equal(t.timers.size,0,'deadlines released');equal(t.launch.status().pending,false,'busy state released');
  }
  for(const mode of ['connect-timeout','timeout']) {
    const t=simulated({post:mode});const pending=t.launch(id);await flush();
    equal((await t.launch(other)).outcome,'busy','a second launch cannot overlap');
    equal(t.calls.length,2,'one status read and one launch request');
    for(const timer of [...t.timers.keys()])timer.fn();
    equal((await pending).outcome,mode==='timeout'?'unknown':'fallback','only a pre-connect timeout permits native fallback');
    equal(t.timers.size,0,'timeout clears deadline');
  }
  for(const value of [null,{...catalog,available:false},{...catalog,address:'192.168.1.77'},{...catalog,apps:[]}]) {
    const t=simulated({catalog:value});equal((await t.launch(id)).outcome,'fallback','absent or stale discovery uses native launch');equal(t.calls.length,0,'no scan or refresh during launch');
  }
  let t=simulated({catalog:{...catalog,address:'192.168.84.19'}});await t.launch(id);
  equal(t.calls.map(x=>[x.hostname,x.localAddress,x.port,x.path,x.method]),[
    ['192.168.84.19','192.168.84.19',8099,'/status','GET'],
    ['192.168.84.19','192.168.84.19',8099,'/apps/launch','POST']
  ],'use the discovered same-TV address and only fixed endpoints');
  equal(JSON.parse(t.calls[1].body),{appId:id},'upstream Vetro request contract');
  await assert.rejects(t.launch('bad;cmd'));checks++;

  let p=platform();equal(await p.P.launchApp(id),'vetro','Vetro accepts ordinary launch');equal(p.calls,[['vetro',id]],'no second native launch');
  p=platform({available:false});equal(await p.P.launchApp(id),'launch','no Vetro remains native');equal(p.calls,[['native',id]],'no Vetro call when absent');
  p=platform({reply:()=>Promise.resolve(false)});await p.P.launchApp(id);equal(p.calls,[['vetro',id],['native',id]],'known unavailable result uses native launch');
  p=platform({reply:()=>Promise.reject(Error('uncertain'))});await assert.rejects(p.P.launchApp(id));checks++;equal(p.calls,[['vetro',id]],'lost reply never duplicates through native launch');
  p=platform({reply:()=>Promise.resolve(false),smartStatus:500});await p.P.launchApp(id,'store-id');equal(p.calls.map(x=>x[0]),['vetro','smart','native'],'Smart Hub failure stays in native fallback without another Vetro POST');
  p=platform({reply:()=>Promise.resolve(false),failNative:true});equal(await p.P.launchApp(id),'appcontrol','native app-control fallback retained');
  let finish;p=platform({reply:()=>new Promise(resolve=>{finish=resolve;})});
  const first=p.P.launchApp(id);assert.strictEqual(p.P.launchApp(id),first);checks++;
  await assert.rejects(p.P.launchApp(other));checks++;finish(true);await first;equal(p.calls.length,1,'repeated selection coalesces');
  p=platform();await p.P.openUrl('https://example.com');await p.P.switchInput(1);
  equal(p.calls.map(x=>x[0]),['control','native'],'browser and input use dedicated native paths');

  // Exercise the authenticated Glass Home endpoint against a real Vetro-shaped HTTP server.
  const requests=[];let rootReady=true,postStatus=200;
  const fake=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
      requests.push([req.method,req.url,body]);res.setHeader('Content-Type','application/json');
      if(req.url==='/dock')res.end(JSON.stringify({entries:[{appId:id,label:'Netflix'}]}));
      else if(req.url==='/status')res.end(JSON.stringify({agent:{connected:rootReady}}));
      else if(req.url==='/apps/launch'){res.statusCode=postStatus;res.end(JSON.stringify({ok:true,sent:1}));}
      else{res.statusCode=404;res.end('{}');}
    });
  });
  await new Promise((resolve,reject)=>{fake.once('error',reject);fake.listen(8099,'127.0.0.1',resolve);});
  fs.mkdirSync(path.join(__dirname,'tmp'),{recursive:true});
  const temp=fs.mkdtempSync(path.join(__dirname,'tmp','vetro-launch-'));
  const svc=require('../app/service/server.js').createService({appDir:path.join(root,'app'),dataDir:temp,port:18496,hosts:['127.0.0.1'],config:{fetchIcons:false},log:()=>{}});
  try {
    await new Promise((resolve,reject)=>svc.start(e=>e?reject(e):resolve()));
    const base='http://127.0.0.1:18496',key='?k='+encodeURIComponent(svc.localKey());
    const send=(data,auth=true)=>fetch(base+'/local/vetro/launch'+(auth?key:''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    equal((await send({appId:id},false)).status,403,'local key required for launches');equal(requests.length,0,'unauthorized request makes no TV calls');
    for(const bad of [null,{},[],{appId:'bad;cmd'},{appId:id,cmd:'id'},{appId:id,address:'example.com'}])equal((await send(bad)).status,400,'bounded app-ID-only input');
    equal((await send({appId:id,padding:'x'.repeat(2100)})).status,413,'launch body size limit');
    equal((await (await send({appId:id})).json()).outcome,'fallback','no discovery means native fallback');
    await fetch(base+'/local/vetro/apps'+key);
    equal((await (await fetch(base+'/health')).json()).vetroLaunch,1,'health advertises launch support');
    const posts=()=>requests.filter(x=>x[0]==='POST').length;
    equal((await (await send({appId:other})).json()).outcome,'fallback','unlisted apps use native path');equal(posts(),0,'unlisted app is not forwarded');
    equal((await (await send({appId:id})).json()).outcome,'accepted','authenticated app request reaches Vetro');equal(posts(),1,'one forwarded launch');
    rootReady=false;equal((await (await send({appId:id})).json()).outcome,'fallback','root not ready uses native path');equal(posts(),1,'root preflight does not launch');
    rootReady=true;postStatus=503;equal((await (await send({appId:id})).json()).outcome,'unknown','a post-submission failure does not claim safe fallback');
    const before=requests.length,diag=await(await fetch(base+'/local/vetro/launch'+key)).json();
    equal(diag.last.outcome,'unknown','authenticated diagnostics report last attempt');equal(requests.length,before,'diagnostics are read-only');

    // Real TV-client data adapter, including an uncertain local-service reply.
    let reply={status:200,data:{appId:id,outcome:'accepted'}};
    function XHR(){this.open=(method,url)=>{this.method=method;this.url=url;};this.setRequestHeader=()=>{};this.send=body=>{equal(JSON.parse(body),{appId:id},'client sends only appId');this.status=reply.status;this.responseText=JSON.stringify(reply.data);this.onload();};}
    const window={GH:{config:{serviceBase:base}},GH_LOCAL_KEY:'fixture-key'};
    vm.runInNewContext(fs.readFileSync(path.join(root,'app/js/data.js'),'utf8'),{window,XMLHttpRequest:XHR,localStorage:{getItem:()=>null,removeItem:()=>{}}});
    equal(await window.GH.data.vetroLaunch(id),true,'client accepts confirmed command');
    reply.data.outcome='fallback';equal(await window.GH.data.vetroLaunch(id),false,'client permits explicit native fallback');
    reply={status:0,data:null};await assert.rejects(window.GH.data.vetroLaunch(id),e=>e.launchUnconfirmed===true);checks++;
    reply={status:404,data:{error:'not-found'}};equal(await window.GH.data.vetroLaunch(id),false,'older Glass Home service has safe native fallback');
  } finally {
    await new Promise(resolve=>svc.stop(resolve));await new Promise(resolve=>fake.close(resolve));fs.rmSync(temp,{recursive:true,force:true});
  }
  console.log('PASS '+checks+' Vetro launch checks: compatible API, native fallback, no duplicate submission, authentication, dedicated paths and diagnostics');
})().catch(e=>{console.error(e);process.exitCode=1;});
