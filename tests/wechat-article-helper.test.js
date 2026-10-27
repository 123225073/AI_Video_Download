import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {WeChatArticleHelper,clientArticle,clientCandidate,wechatClientAction} from '../electron/wechat-article-helper.js';
import {Articles} from '../electron/articles.js';
const author={name:'目标账号',username:'gh_test',biz:'MzkwNjQ0MTIzNA=='};
const entry=n=>({title:'文章'+n,author:author.name,url:'https://mp.weixin.qq.com/s?'+new URLSearchParams({__biz:author.biz,mid:String(n),idx:'1',sn:'public',chksm:'integrity',key:'private',pass_ticket:'private'}),nativeKey:'date|文章'+n+'|0',date:'10月7日'});
function native(respond){const calls=[];let killed=0;return {calls,launch(_exe,args){const action=args[0],config=JSON.parse(Buffer.from(args[1],'base64').toString());calls.push({action,config});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed++;queueMicrotask(()=>child.emit('close',1));};queueMicrotask(()=>{child.stdout.write(JSON.stringify({kind:'result',value:{ok:true,author:author.name,username:author.username,...respond(action,config)}})+'\n');child.emit('close',0);});return child;},get killed(){return killed;}};}
const makeHelper=stub=>new WeChatArticleHelper('bin',{launch:stub.launch,platform:'win32',exists:()=>true,wait:async()=>{}});
test('list discovery reads real cards and scrolls without opening article tabs',async()=>{
 let round=0;const stub=native(action=>action==='inspect'?{profileFound:true,cards:(round?[1,2,3,4]:[1,2]).map(n=>({title:entry(n).title,key:entry(n).nativeKey})),complete:false}:action==='scroll'?(round++,{}):assert.fail('list must never invoke '+action));
 const page=await makeHelper(stub).list(author,{limit:3});assert.equal(page.items.length,3);assert.ok(page.items.every(i=>i.url===null&&i.clientReference.biz===author.biz));assert.deepEqual(stub.calls.map(x=>x.action),['inspect','scroll','inspect']);
 const next=await makeHelper(stub).list(author,{limit:1,knownKeys:page.items.map(i=>i.nativeKey)});assert.equal(next.items[0].title,'文章4');
});
test('native references reject another account and resolve only the selected card',async()=>{
 const candidate=clientCandidate(entry(2),author);assert.throws(()=>clientCandidate({...candidate,clientReference:{biz:'wrong',username:author.username}},author));
 const stub=native(action=>action==='inspect'?{profileFound:true,cards:[1,2,3].map(n=>({title:entry(n).title,key:entry(n).nativeKey}))}:action==='read-article'?{ready:true,item:entry(2)}:{});
 const page=await makeHelper(stub).collect(author,{limit:1,targetKey:candidate.nativeKey});assert.equal(page.items[0].title,'文章2');assert.equal(stub.calls.find(x=>x.action==='open-card').config.cardKey,candidate.nativeKey);assert.equal(stub.calls.filter(x=>x.action==='open-card').length,1);
});
test('client links retain public integrity parameters and exclude client session fields',()=>{
 const item=clientArticle(entry(1),author),url=new URL(item.url);assert.equal(url.searchParams.get('chksm'),'integrity');assert.equal(url.searchParams.has('key'),false);assert.equal(url.searchParams.has('pass_ticket'),false);
 assert.equal(item.nativeKey,entry(1).nativeKey);assert.throws(()=>clientArticle({...entry(1),author:'other'},author));assert.throws(()=>clientArticle({...entry(1),url:'https://mp.weixin.qq.com/s?__biz=other&mid=1'},author));
});
test('fresh steps open once, observe passively, return and verify the profile before continuing',async()=>{
 let reading=0;const cards=[1,2].map(n=>({title:entry(n).title,key:entry(n).nativeKey}));
 const stub=native(action=>action==='inspect'?{profileFound:true,cards}:action==='read-article'?{ready:++reading>1,item:entry(2)}:{});const received=[];
 const page=await makeHelper(stub).collect(author,{limit:1,knownKeys:[entry(1).nativeKey],received:(items,pending)=>received.push({items,pending})});
 assert.deepEqual(stub.calls.map(x=>x.action),['inspect','open-card','read-article','read-article','return-article','inspect']);assert.equal(stub.calls[1].config.cardKey,entry(2).nativeKey);
 assert.equal(page.source,'wechat-client');assert.equal(page.items.length,1);assert.equal(page.returnedToOriginalProfile,true);assert.ok(received[0].pending);assert.equal(received.at(-1).pending,null);
});
test('wrong account is rejected; interrupted return retains the real item and recovery URL',async()=>{
 const invalid=native(()=>({author:'other'}));await assert.rejects(makeHelper(invalid).collect(author),e=>e.wechatClient);
 const partial=native(action=>action==='inspect'?{profileFound:true,cards:[{title:entry(1).title,key:entry(1).nativeKey}]}:action==='read-article'?{ready:true,item:entry(1)}:action==='return-article'?{ok:false}:{});
 const p=await makeHelper(partial).collect(author,{limit:1});assert.equal(p.items.length,1);assert.equal(p.needsAction,true);assert.equal(p.action,'wechat-client');assert.equal(p.clientPending,p.items[0].url);
});
test('cancellation after a public URL was read still returns only that article without another open',async()=>{
 const controller=new AbortController();let returned=false;const stub=native(action=>action==='inspect'?{profileFound:true,cards:[{title:entry(1).title,key:entry(1).nativeKey}]}:action==='read-article'?{ready:true,item:entry(1)}:action==='return-article'?(returned=true,{}):{});
 await assert.rejects(makeHelper(stub).collect(author,{limit:1,signal:controller.signal,received:()=>controller.abort(Error('STOP'))}),/STOP/);assert.equal(returned,true);assert.equal(stub.calls.filter(x=>x.action==='open-card').length,1);
});
test('same-account article can navigate back to its author profile and exhaustion is not invented',async()=>{
 let profile=false;const stub=native(action=>action==='inspect'?{profileFound:profile,cards:[],articles:[]}:action==='author-profile'?(profile=true,{}):{});
 const page=await makeHelper(stub).collect(author,{limit:1});assert.equal(page.complete,false);assert.equal(page.items.length,0);assert.equal(stub.calls.filter(x=>x.action==='author-profile').length,1);
});
function store(){const rows=new Map();return {get:(k,id)=>structuredClone(rows.get(k+id)||null),put:(k,id,v)=>rows.set(k+id,structuredClone(v)),list:()=>[],flush(){}};}
test('Update continues the same desktop account task and preserves its existing native keys',async()=>{
 const s=store();let round=0,previous;const reader={identifyAuthor:async()=>author,discover:async(_r,p)=>{previous=p;return {source:'wechat-client',items:[clientArticle(entry(++round),author)],complete:false};},close(){}};
 const center=new Articles({store:s,directory:'.',reader});const request={mode:'author',platform:'公众号',input:'https://mp.weixin.qq.com/s/seed',limit:3};await center.start(request);const id=center.record.id;await center.start(request);
 assert.equal(previous.id,id);assert.equal(center.record.id,id);assert.equal(center.record.items.length,2);assert.equal(center.record.items[0].nativeKey,entry(1).nativeKey);
});
test('pending native rows survive incremental discovery and become selectable without invented URLs',async()=>{
 const s=store();let round=0;const center=new Articles({store:s,directory:'.',reader:{identifyAuthor:async()=>author,discover:async()=>({source:'wechat-client',items:[clientCandidate(entry(++round),author)],complete:false}),close(){}}});
 const request={mode:'author',platform:'公众号',input:'https://mp.weixin.qq.com/s/seed',limit:1};await center.start(request);const id=center.record.id;await center.start(request);assert.equal(center.record.id,id);assert.equal(center.record.items.length,2);assert.ok(center.record.items.every(i=>i.url===null&&i.nativeKey));assert.equal(s.get('article-meta','discovery').items.length,2);
});
test('a failed body download keeps the real URL so retry never reopens the WeChat article',async()=>{
 const s=store();let resolves=0,reads=0;const candidate=clientCandidate(entry(1),author),center=new Articles({store:s,directory:'.',reader:{identifyAuthor:async()=>author,discover:async()=>({source:'wechat-client',items:[candidate],complete:false}),resolveClient:async()=>{resolves++;return clientArticle(entry(1),author).url;},read:async()=>{reads++;throw Error('temporary body failure');},close(){}}});
 await center.start({mode:'author',platform:'公众号',input:'https://mp.weixin.qq.com/s/seed',limit:1});await center.collect([candidate.id]);assert.equal(center.record.items[0].status,'failed');assert.ok(s.get('article-meta','discovery').items[0].url);await center.collect([candidate.id]);assert.equal(resolves,1);assert.equal(reads,2);
});
test('saving an unresolved item after WeChat closes exposes the client guide and preserves its row',async()=>{
 const s=store(),candidate=clientCandidate(entry(1),author);let attempt=0;const center=new Articles({store:s,directory:'.',reader:{identifyAuthor:async()=>author,discover:async()=>({source:'wechat-client',items:[candidate],complete:false}),resolveClient:async()=>{if(++attempt===1)throw wechatClientAction();return clientArticle(entry(1),author).url;},read:async()=>{throw Error('temporary body failure');},close(){}}});
 await center.start({mode:'author',platform:'公众号',input:'https://mp.weixin.qq.com/s/seed',limit:1});await center.collect([candidate.id]);assert.equal(center.record.status,'needs-action');assert.equal(center.record.action,'wechat-client');assert.equal(center.record.items.length,1);assert.equal(center.record.items[0].id,candidate.id);await center.collect([candidate.id]);assert.equal(center.record.action,null);assert.equal(center.record.status,'ready');
});
test('old backend refusal becomes desktop guidance without making requests or discarding the original task',()=>{
 const s=store();s.put('article-meta','discovery',{id:'kept',request:{mode:'author',platform:'公众号',input:'https://mp.weixin.qq.com/s/seed'},authorContext:author,action:'wechat-rate-limit',status:'needs-action',items:[],message:'200013'});
 const center=new Articles({store:s,directory:'.',reader:{clientHelper:{},accountAccess:{state:{retryAt:99999}}}});assert.equal(center.record.id,'kept');assert.equal(center.record.action,'wechat-client');assert.equal(center.record.restriction,null);assert.equal(wechatClientAction().wechatClient,true);
});
