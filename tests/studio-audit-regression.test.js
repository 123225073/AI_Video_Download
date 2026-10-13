import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {transformSync} from 'esbuild';
import {AIService} from '../electron/ai.js';
import {readTextStream,draftTextPreview} from '../electron/ai-stream.js';
import * as policy from '../electron/remix-policy.js';
import {assetPairs,referenceAsset} from '../src/asset-pairs.js';
import {Store} from '../electron/store.js';

// Regression inputs from output/audit-20261013-studio/backend/reproduce.mjs
// and ui-agent/ui-stub-audit.mjs. Transport, keys and images are synthetic.
const frame=v=>'data: '+JSON.stringify(v)+'\n\n';
const streamFrames=protocol=>protocol==='chat'
  ?frame({choices:[{index:0,delta:{content:'完整正文'},finish_reason:'stop'}]})
  :frame({type:'response.output_text.delta',output_index:0,content_index:0,delta:'完整正文'})+frame({type:'response.completed',response:{status:'completed'}});
for(const protocol of ['chat','responses'])test(`${protocol}完成标志后连接不关闭也返回正文并释放读取`,async()=>{
  let cancelled=false,controller;
  const response=new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode(streamFrames(protocol)));},cancel(){cancelled=true;}}));
  const abort=new AbortController(),timer=setTimeout(()=>{abort.abort();try{controller.error(abort.signal.reason);}catch{}},150);
  try{assert.equal(await readTextStream(response,protocol,abort.signal,()=>{}),'完整正文');assert.equal(cancelled,true);}finally{clearTimeout(timer);}
});
for(const mode of ['timeout','cancel'])test(`AI正文读取阶段区分${mode}`,async()=>{
  const user=new AbortController();
  const ai=new AIService({},'',{},()=>{},async(_url,{signal})=>new Response(new ReadableStream({start(c){signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});}}),{headers:{'content-type':'text/event-stream'}}));
  ai.config=()=>({baseUrl:'https://example.invalid',timeout:.025,protocol:'chat'});ai.secret=()=> 'SYNTHETIC';
  const timer=setTimeout(()=>{if(mode==='cancel')user.abort();},5),keepAlive=setTimeout(()=>{},100);
  try{await assert.rejects(ai.request('text','chat/completions',{},user.signal,()=>{}),mode==='timeout'?/超时/:/已停止处理/);}finally{clearTimeout(timer);clearTimeout(keepAlive);}
});
test('仅DONE、空正文、截断与损坏响应仍不能保存为成功',async()=>{
  for(const raw of ['data: [DONE]\n\n',frame({choices:[{index:0,delta:{},finish_reason:'stop'}]}),frame({choices:[{index:0,delta:{content:'片段'},finish_reason:'length'}]}),'data: {broken}\n\n'])
    await assert.rejects(readTextStream(new Response(raw),'chat',null,()=>{}));
});

const sandbox={fs,path,randomUUID,Buffer,URL,Response,Blob,FormData,AbortController,AbortSignal,structuredClone,draftTextPreview,...policy,apiBase:b=>b,
  fetch:()=>{throw Error('Real network prohibited');},nativeImage:{createFromBuffer:b=>({isEmpty:()=>!b.length,toPNG:()=>b})}};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync('electron/content-studio.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.ContentStudio=ContentStudio',sandbox);
function fixture(t,fetcher=async()=>new Response('{}',{status:503})){
  const directory=path.resolve('output/studio-fix-regression',randomUUID());fs.mkdirSync(path.join(directory,'draft'),{recursive:true});
  const file=path.join(directory,'draft/original.png');fs.writeFileSync(file,'synthetic-image');
  const data=new Map([['draft',{id:'draft',source:{id:'source',platform:'小红书',type:'image'},original:{title:'原题',text:'原文',images:['synthetic']},title:'原题',body:'原文',tags:'',assets:[{id:'a',file,kind:'image',origin:'original'}],assetOrder:['a'],status:'draft',revision:1}]]);
  const store={get:(_k,id)=>structuredClone(data.get(id)),list:k=>k==='content-draft'?[...data.values()].map(d=>structuredClone(d)):[],put:(_k,id,d)=>data.set(id,structuredClone(d)),flush(){}};
  const options={directory,store,search:{active:null},browser:{close(){}},ai:{config:()=>({hasKey:true,model:'synthetic',baseUrl:'https://example.invalid',timeout:.025}),secret:()=> 'SYNTHETIC',chat:async()=>JSON.stringify({title:'新题',body:'新正文',tags:''})},fetcher};
  // Keep isolated evidence; never open the application's production store.
  return {studio:new sandbox.ContentStudio(options),data,options,file,reopen:()=>new sandbox.ContentStudio(options)};
}
for(const entry of ['single','whole'])test(`${entry}图片503原因和失败素材重进后可查`,async t=>{
  const f=fixture(t);await assert.rejects(entry==='single'?f.studio.editImage('draft','a','轻调'):f.studio.remix('draft','轻调'),/503/);
  const d=f.reopen().get('draft');assert.match(d.message,/503/);assert.match(d.imageFailures.a.message,/503/);assert.equal(d.imageFailures.a.assetId,'a');assert.equal(d.imageOperation.status,'failed');assert.equal(fs.readFileSync(f.file,'utf8'),'synthetic-image');
  if(entry==='whole'){assert.equal(d.remixSummary.status,'partial');assert.match(d.remixSummary.error.message,/503/);assert.equal(d.body,'新正文');}
});
test('重启恢复running整篇摘要与单图状态为中断，保留已完成部分',t=>{
  const f=fixture(t),d=f.data.get('draft');d.body='已生成文案';d.remixSummary={status:'running',scope:'all',text:{status:'generated'},images:{status:'pending',generated:1,total:2,generatedAssetIds:['saved']}};d.imageOperation={status:'running',assetId:'a',startedAt:1};f.data.set('draft',d);
  const restored=f.reopen(),next=restored.get('draft');assert.equal(next.remixSummary.status,'partial');assert.equal(next.remixSummary.images.status,'interrupted');assert.equal(next.remixSummary.text.status,'generated');assert.equal(next.remixSummary.images.generated,1);assert.equal(next.imageOperation.status,'interrupted');assert.equal(next.imageFailures.a.status,'interrupted');assert.match(next.message,/中断/);assert.equal(next.body,'已生成文案');assert.equal(restored.progress(),null);
  assert.equal(f.reopen().get('draft').imageOperation.endedAt,next.imageOperation.endedAt);
});
test('单图失败后的成功重试清除当前失败而保留原图',async t=>{
  let success=false;const f=fixture(t,async()=>success?new Response(JSON.stringify({data:[{b64_json:Buffer.from('generated-image').toString('base64')}]})):new Response('{}',{status:503}));
  await assert.rejects(f.studio.editImage('draft','a','轻调'));success=true;const d=await f.studio.editImage('draft','a','轻调');assert.equal(d.imageFailures.a,undefined);assert.equal(d.imageOperation.status,'completed');assert.equal(d.assets.length,2);assert.equal(fs.readFileSync(f.file,'utf8'),'synthetic-image');
});
for(const mode of ['timeout','cancel'])test(`图片${mode}持久化准确原因`,async t=>{
  let f;f=fixture(t,async(_url,{signal})=>{if(mode==='cancel')f.studio.cancel();await new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});});
  const keepAlive=setTimeout(()=>{},100);try{await assert.rejects(f.studio.editImage('draft','a','轻调'),mode==='timeout'?/超时/:/已停止/);}finally{clearTimeout(keepAlive);}
  const d=f.reopen().get('draft');assert.match(d.imageFailures.a.message,mode==='timeout'?/超时/:/已停止/);assert.equal(d.imageOperation.status,mode==='timeout'?'failed':'cancelled');
});

// In-memory JSX callback/render harness reused from the prior UI audit.
const node=(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}});
function harness(file){
  const slots=[],deps=[];let cursor=0,tree;
  const react={createElement:node,useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useEffect(fn,next){const i=cursor++;if(!deps[i]||next.some((v,k)=>!Object.is(v,deps[i][k]))){deps[i]=next;fn();}}};
  const imports={react,'./asset-pairs.js':{assetPairs,referenceAsset},'../electron/remix-policy.js':policy,'lucide-react':new Proxy({},{get:()=>()=>null})},context={module:{exports:{}},require:n=>imports[n]||{},Date,setInterval:()=>0,clearInterval(){}};context.exports=context.module.exports;
  vm.runInNewContext(transformSync(fs.readFileSync(file,'utf8'),{loader:'jsx',format:'cjs',jsx:'transform'}).code,context);
  return {render(props){cursor=0;tree=context.module.exports.default(props);return tree;},get tree(){return tree;}};
}
const text=n=>n==null||n===false?'':typeof n==='object'?(n.props?.children||[]).map(text).join(''):String(n);
const all=(n,p)=>!n||typeof n!=='object'?[]:[...(p(n)?[n]:[]),...(n.props?.children||[]).flatMap(c=>all(c,p))];
const field=(h,label)=>all(h.tree,n=>n.props?.['aria-label']===label)[0];
const button=(h,label)=>all(h.tree,n=>n.type==='button'&&text(n)===label)[0];
test('单图按钮使用当前可见页签的方向和参考，隐藏空设置不禁用',()=>{
  const h=harness('src/StudioComparison.jsx');let prompt='可见整篇方向',imagePrompt='',calls=[];
  const props=()=>({draft:{id:'d',source:{type:'image'},original:{title:'原题',text:'原文'},title:'成稿',body:'正文',tags:'',status:'draft',assets:[{id:'a',origin:'original'}],assetOrder:['a']},prompt,imagePrompt,setPrompt:v=>prompt=v,setImagePrompt:v=>imagePrompt=v,onEditImage:(...a)=>calls.push(a)});
  h.render(props());h.render(props());assert.equal(button(h,'AI 修改此图').props.disabled,false);button(h,'AI 修改此图').props.onClick();assert.equal(calls.at(-1)[1],prompt);
  button(h,'仅图片').props.onClick();h.render(props());field(h,'图片参考底图').props.onChange({target:{value:'current'}});field(h,'图片二创要求').props.onChange({target:{value:'隐藏图片方向'}});h.render(props());
  button(h,'文案＋图片').props.onClick();h.render(props());button(h,'AI 修改此图').props.onClick();assert.equal(calls.at(-1)[1],prompt);assert.equal(calls.at(-1)[2].reference,'original');
  button(h,'仅图片').props.onClick();h.render(props());button(h,'AI 修改此图').props.onClick();assert.equal(calls.at(-1)[1],imagePrompt);assert.equal(calls.at(-1)[2].reference,'current');
});
test('重进工作台显示单图失败原因，进度不能误报已保存成功',()=>{
  const failure={assetId:'a',message:'CPA 图片上游暂不可用（HTTP 503）',status:'failed'},draft={id:'d',source:{type:'image'},original:{},title:'t',body:'b',tags:'',assets:[{id:'a',origin:'original'}],assetOrder:['a'],imageFailures:{a:failure},imageOperation:failure};
  const comparison=harness('src/StudioComparison.jsx');comparison.render({draft,prompt:'方向',imagePrompt:''});assert.match(text(comparison.tree),/503/);
  const progress=harness('src/StudioProgress.jsx');progress.render({draft,busy:false});assert.match(text(progress.tree),/503/);assert.doesNotMatch(text(progress.tree),/内容已保存，开始创作吧/);
});

test('失败整篇的单图重试成功后更新计数并清除过时503',async t=>{
  let success=false;const f=fixture(t,async()=>success?new Response(JSON.stringify({data:[{b64_json:Buffer.from('image').toString('base64')}]})):new Response('{}',{status:503}));
  await assert.rejects(f.studio.remix('draft','轻调'));success=true;const d=await f.studio.editImage('draft','a','轻调');
  assert.equal(d.remixSummary.images.generated,1);assert.equal(d.remixSummary.status,'completed');assert.equal(d.remixSummary.error,undefined);
});
test('第二张失败只标记第二张且保留第一张生成文件和原图',async t=>{
  let calls=0;const f=fixture(t,async()=>++calls===2?new Response('{}',{status:503}):new Response(JSON.stringify({data:[{b64_json:Buffer.from('generated').toString('base64')}]})));
  const second=path.join(f.options.directory,'draft','second.png');fs.writeFileSync(second,'second-original');const raw=f.data.get('draft');raw.assets.push({id:'b',file:second,kind:'image',origin:'original'});raw.assetOrder.push('b');f.data.set('draft',raw);
  await assert.rejects(f.studio.remix('draft','轻调'));const d=f.reopen().get('draft');assert.equal(d.remixSummary.images.generated,1);assert.equal(d.remixSummary.images.total,2);assert.equal(d.imageFailures.a,undefined);assert.match(d.imageFailures.b.message,/503/);assert.equal(fs.readFileSync(d.assets.at(-1).file,'utf8'),'generated');assert.equal(fs.readFileSync(second,'utf8'),'second-original');
});
test('真实隔离SQLite关闭重开保留503，并将运行中状态落盘为中断',async t=>{
  const f=fixture(t),database=path.join(f.options.directory,'isolated-db');let store=await Store.open(database,{});
  try{
    store.put('content-draft','draft',f.data.get('draft'));store.flush();let studio=new sandbox.ContentStudio({...f.options,store});await assert.rejects(studio.editImage('draft','a','轻调'),/503/);store.close();store=await Store.open(database,{});
    studio=new sandbox.ContentStudio({...f.options,store});assert.match(studio.get('draft').imageFailures.a.message,/503/);
    const d=store.get('content-draft','draft');d.imageOperation={status:'running',assetId:'a',startedAt:1};d.remixSummary={status:'running',text:{status:'generated'},images:{status:'pending',generated:0,total:1}};store.put('content-draft','draft',d);store.close();store=await Store.open(database,{});
    studio=new sandbox.ContentStudio({...f.options,store});assert.equal(studio.get('draft').imageOperation.status,'interrupted');store.close();store=await Store.open(database,{});assert.equal(store.get('content-draft','draft').remixSummary.status,'partial');assert.equal(store.get('content-draft','draft').imageFailures.a.status,'interrupted');
  }finally{store.close();}
});
for(const kind of ['text-json','image-body'])test(`${kind}收到响应头后卡住仍区分超时`,async t=>{
  const fetcher=async(_url,{signal})=>new Response(new ReadableStream({start(c){signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});}}));
  const keepAlive=setTimeout(()=>{},100);
  try{
    if(kind==='image-body'){const f=fixture(t,fetcher);await assert.rejects(f.studio.editImage('draft','a','轻调'),/超时/);assert.match(f.reopen().get('draft').imageFailures.a.message,/超时/);}
    else{const ai=new AIService({},'',{},()=>{},fetcher);ai.config=()=>({baseUrl:'https://example.invalid',timeout:.025});ai.secret=()=> 'SYNTHETIC';await assert.rejects(ai.request('text','responses',{}),/超时/);}
  }finally{clearTimeout(keepAlive);}
});
test('无底层abort支持的挂起流也能主动停止，正文不会当成完整稿',async()=>{
  let cancelled=false;const controller=new AbortController();const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame({choices:[{index:0,delta:{content:'片段'}}]})));},cancel(){cancelled=true;}}));
  const pending=readTextStream(response,'chat',controller.signal,()=>{});setTimeout(()=>controller.abort(),5);await assert.rejects(pending,/已停止/);assert.equal(cancelled,true);
});
test('读取完成后忽略连接上后续数据，不泄露或拼入正文',async()=>{
  const seen=[];assert.equal(await readTextStream(new Response(streamFrames('chat')+'data: {broken}\n\n'),'chat',null,v=>seen.push(v)),'完整正文');assert.deepEqual(seen,['完整正文']);
});
test('仅文案页签隐藏单图编辑且重启中断在进度区可见',()=>{
  const h=harness('src/StudioComparison.jsx'),draft={id:'d',source:{type:'image'},original:{},title:'t',body:'b',tags:'',assets:[{id:'a',origin:'original'}],assetOrder:['a']},props={draft,prompt:'方向',imagePrompt:''};h.render(props);h.render(props);button(h,'仅文案').props.onClick();h.render(props);assert.equal(button(h,'AI 修改此图'),undefined);
  const progress=harness('src/StudioProgress.jsx');progress.render({draft:{...draft,imageOperation:{status:'interrupted',message:'上次图片修改中断'}},busy:false});assert.match(text(progress.tree),/中断/);assert.doesNotMatch(text(progress.tree),/内容已保存，开始创作吧/);
});
