import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {externalChromeStatus,chromeActivePort,externalOfficialURL,ExternalBrowser,ExternalBrowserTab} from '../electron/external-browser.js';

const version={Browser:'Chrome/155.0.1.0',webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/browser/fixture-id'};
const read=async()=>({statusCode:200,body:JSON.stringify(version)});
test('empty and non-JSON HTTP responses are not accepted as a Chrome connection',async()=>{
 for(const body of ['', '<html>not a CDP endpoint</html>', '{}']){
  const status=await externalChromeStatus({discover:false,read:async()=>({statusCode:200,body})});
  assert.equal(status.available,false);assert.equal(status.reason,'invalid-response');
 }
 const denied=await externalChromeStatus({discover:false,read:async()=>({statusCode:404,body:''})});
 assert.equal(denied.reason,'http-error');assert.equal(denied.httpStatus,404);
});
test('Chrome endpoint discovery never connects outside loopback or trusts remote WebSocket metadata',async()=>{
 let reads=0;
 const forbidden=await externalChromeStatus({endpoint:'http://evil.invalid:9222',read:async()=>{reads++;return {};}});
 assert.equal(forbidden.reason,'invalid-endpoint');assert.equal(reads,0);
 for(const socket of ['ws://evil.invalid:9222/devtools/browser/id','ws://127.0.0.1:9333/devtools/browser/id','ws://user:secret@127.0.0.1:9222/devtools/browser/id']){
  const s=await externalChromeStatus({discover:false,read:async()=>({statusCode:200,body:JSON.stringify({...version,webSocketDebuggerUrl:socket})})});
  assert.equal(s.available,false);
 }
});
test('Chrome144 permission mode discovers only the standard active-port file and reports approval honestly',async()=>{
 const socket=await chromeActivePort({file:'explicit-standard-file',readFile:async(file)=>{assert.equal(file,'explicit-standard-file');return '9333\n/devtools/browser/permission-id\n';}});
 assert.equal(socket,'ws://127.0.0.1:9333/devtools/browser/permission-id');
 const status=await externalChromeStatus({read:async()=>({statusCode:404,body:''}),readActivePort:async()=>socket});
 assert.equal(status.available,false);assert.equal(status.canConnect,true);assert.equal(status.requiresApproval,true);assert.equal(status.reason,'requires-approval');
 for(const content of ['0\n/devtools/browser/id','65536\n/devtools/browser/id','9333\n//evil.invalid/id','9333\n/devtools/page/id','9333\n/devtools/browser/id\nextra'])
  assert.equal(await chromeActivePort({file:'fixture',readFile:async()=>content}),null);
});
test('only supported official platform pages and authentication hosts can be opened',()=>{
 assert.equal(externalOfficialURL('YouTube','https://accounts.google.com/v3/signin/identifier'),true);
 assert.equal(externalOfficialURL('YouTube','https://www.google.com/sorry/index'),true);
 assert.equal(externalOfficialURL('B站','https://passport.bilibili.com/login'),true);
 for(const url of ['https://www.youtube.com.evil.invalid/watch?v=x','http://www.youtube.com/','file:///C:/private','https://u:p@www.youtube.com/','https://www.youtube.com:7897/','https://mail.google.com/'])assert.equal(externalOfficialURL('YouTube',url),false,url);
 assert.equal(externalOfficialURL('小红书','https://www.youtube.com/'),false);
});

class Socket extends EventTarget{
 static instances=[];
 constructor(url){super();this.url=url;this.readyState=0;this.commands=[];this.urls=new Map();this.targets=0;Socket.instances.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
 send(raw){const m=JSON.parse(raw);this.commands.push(m);let result={};
  if(m.method==='Browser.getVersion')result={product:'Chrome/155'};
  if(m.method==='Target.createTarget')result={targetId:'own-'+(++this.targets)};
  if(m.method==='Target.attachToTarget')result={sessionId:'session-'+m.params.targetId};
  if(m.method==='Target.closeTarget')result={success:true};
  if(m.method==='Page.navigate'){this.urls.set(m.sessionId,m.params.url);result={frameId:'main',loaderId:'load'};}
  if(m.method==='Page.getFrameTree')result={frameTree:{frame:{url:this.urls.get(m.sessionId)||'about:blank'}}};
  if(m.method==='Runtime.evaluate')result={result:{value:{comments:[{text:'Existing Chrome public comment'}]}}};
  if(m.method==='Network.getResponseBody')result={body:'{"public":true}',base64Encoded:false};
  queueMicrotask(()=>{this.message({id:m.id,result});if(m.method==='Page.navigate'){this.message({sessionId:m.sessionId,method:'Page.frameNavigated',params:{frame:{id:'main',url:m.params.url}}});this.message({sessionId:m.sessionId,method:'Page.domContentEventFired',params:{timestamp:1}});}});
 }
 close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
}
const manager=()=>new ExternalBrowser({read,discover:false,WebSocketImpl:Socket,timeoutMs:100,connectTimeoutMs:100});
test('native CDP creates only its own targets, keeps Chrome default profile, evaluates DOM and closes only owned tabs',async()=>{
 const browser=manager();const tab=await browser.open('https://www.youtube.com/watch?v=vUno6VvDnGk',{platform:'YouTube'});
 const socket=Socket.instances.at(-1);assert.equal((await browser.status()).available,true);
 assert.equal(await tab.currentURL(),'https://www.youtube.com/watch?v=vUno6VvDnGk');
 assert.deepEqual(await tab.evaluate('document.querySelectorAll("#comments")'),{comments:[{text:'Existing Chrome public comment'}]});
 await tab.show();assert.deepEqual(await tab.responseBody('own-request'),{body:'{"public":true}',base64Encoded:false});
 assert.equal(socket.commands.some(c=>/getTargets|createBrowserContext|getCookies|getAllCookies|setCookie|setProxy|Browser.close/.test(c.method)),false);
 const create=socket.commands.find(c=>c.method==='Target.createTarget');assert.equal(create.params.browserContextId,undefined);assert.equal(create.params.background,true);
 await browser.close();assert.deepEqual(socket.commands.filter(c=>c.method==='Target.closeTarget').map(c=>c.params.targetId),['own-1']);
});
test('an arbitrary claimed target cannot be evaluated, activated or closed',async()=>{
 const browser=manager();await browser.connect();const forged=new ExternalBrowserTab(browser,'user-existing-tab',()=>true);
 await assert.rejects(()=>forged.evaluate('document.title'));
 await assert.rejects(()=>forged.show());await assert.rejects(()=>forged.close());
 const socket=Socket.instances.at(-1);assert.equal(socket.commands.some(c=>c.params?.targetId==='user-existing-tab'),false);await browser.close();
});
test('deferred navigation installs listeners before the first request and raw commands cannot target another browser',async()=>{
 const browser=manager(),events=[];
 const tab=await browser.open('https://www.youtube.com/',{platform:'YouTube',deferNavigation:true,onEvent:(method)=>events.push(method)}),socket=Socket.instances.at(-1);
 assert.equal(socket.commands.some(c=>c.method==='Page.navigate'),false);assert.equal(tab.url,'about:blank');
 await tab.navigate('https://www.youtube.com/watch?v=vUno6VvDnGk');
 assert.equal(events.includes('Page.domContentEventFired'),true);
 assert.equal(tab.url,'https://www.youtube.com/watch?v=vUno6VvDnGk');
 for(const method of ['Browser.close','Target.attachToTarget','Network.getAllCookies','Storage.getCookies'])await assert.rejects(()=>tab.send(method,{}),/授权范围/);
 await assert.rejects(()=>tab.send('Page.navigate',{url:'https://evil.invalid/'}));await browser.close();
});
test('network events stay within their owned session and never forward Cookie headers or ExtraInfo',async()=>{
 const browser=manager();const tab=await browser.open('https://www.bilibili.com/video/BV1qkYu63E7x',{platform:'B站'});
 const socket=Socket.instances.at(-1),events=[];tab.on('event',(method,p)=>events.push({method,p}));
 socket.message({sessionId:'someone-else',method:'Network.requestWillBeSent',params:{requestId:'foreign'}});
 socket.message({sessionId:tab.sessionId,method:'Network.requestWillBeSentExtraInfo',params:{associatedCookies:['private']}});
 socket.message({sessionId:tab.sessionId,method:'Network.requestWillBeSent',params:{requestId:'own',request:{url:'https://www.bilibili.com/public',headers:{Cookie:'private',Authorization:'private',Accept:'application/json'}}}});
 assert.equal(events.length,1);assert.deepEqual(events[0].p.request.headers,{Accept:'application/json'});await browser.close();
});
test('Google and platform sign-in payloads and responses remain in Chrome rather than reaching application listeners',async()=>{
 const browser=manager(),events=[];
 const tab=await browser.open('https://www.youtube.com/',{platform:'YouTube',onEvent:(method,params)=>{if(method.startsWith('Network.'))events.push(params);}}),socket=Socket.instances.at(-1);
 for(const [id,url] of [['google','https://accounts.google.com/v3/signin/challenge/pwd'],['platform','https://passport.bilibili.com/x/passport-login/web/login'],['xhs','https://edith.xiaohongshu.com/api/sns/web/v1/login/activate']]){
  socket.message({sessionId:tab.sessionId,method:'Network.requestWillBeSent',params:{requestId:id,request:{url,postData:'private-login-input'}}});
  socket.message({sessionId:tab.sessionId,method:'Network.loadingFinished',params:{requestId:id}});
  await assert.rejects(()=>tab.responseBody(id),/只保留在 Chrome/);
 }
 assert.deepEqual(events,[]);await browser.close();
});
test('leaving an official platform refuses DOM reads and callers cannot broaden the platform allowlist',async()=>{
 const browser=manager();await assert.rejects(()=>browser.open('https://evil.invalid/',{platform:'YouTube',allowURL:()=>true}));
 const tab=await browser.open('https://www.youtube.com/',{platform:'YouTube'}),socket=Socket.instances.at(-1);
 socket.urls.set(tab.sessionId,'https://evil.invalid/');await assert.rejects(()=>tab.evaluate('document.body.innerText'),/离开所选平台/);
 await assert.rejects(()=>tab.navigate('https://evil.invalid/'));await browser.close();
});
test('approval timeout stays explicit and does not create a fresh browser or tab',async()=>{
 class Unapproved extends EventTarget{constructor(){super();this.readyState=0;}close(){this.dispatchEvent(new Event('close'));}}
 const browser=new ExternalBrowser({read:async()=>({statusCode:404,body:''}),readActivePort:async()=>version.webSocketDebuggerUrl,WebSocketImpl:Unapproved,connectTimeoutMs:5});
 await assert.rejects(()=>browser.connect(),e=>e.reason==='requires-approval'&&e.requiresApproval);assert.equal(browser.tabs.size,0);
});
test('closing an owned tab releases a pending navigation immediately instead of leaving the workflow waiting',async()=>{
 class LoadingSocket extends Socket{send(raw){const message=JSON.parse(raw);if(message.method!=='Page.navigate')return super.send(raw);this.commands.push(message);this.message({id:message.id,result:{frameId:'main',loaderId:'waiting'}});}}
 const browser=new ExternalBrowser({read,discover:false,WebSocketImpl:LoadingSocket,timeoutMs:100,connectTimeoutMs:100});
 const tab=await browser.open('https://www.youtube.com/',{platform:'YouTube',deferNavigation:true});
 const loading=tab.navigate('https://www.youtube.com/',{timeoutMs:10000});const rejected=assert.rejects(loading,/网页已关闭/);
 await tab.close();await rejected;await browser.close();
});
