import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {buildAssetPairs} from '../electron/remix-policy.js';
const sandbox={fs,path,randomUUID,Buffer,URL,Response,AbortController,AbortSignal,fetch,buildAssetPairs};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('electron/content-studio.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.ContentStudio=ContentStudio',sandbox);
function fixture(t,status='ready',extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-transcript-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const draft={id:'d',source:{type:'video',platform:'YouTube'},original:{text:'',title:'猫'},body:'',title:'猫',assets:[],assetOrder:[],status:'transcribing',transcriptionId:'t',revision:1,createdAt:1000,...extra};
  const data=new Map([['content-draft:d',draft],['transcription:t',{id:'t',status,transcript:'已取得的原视频口播。',transcriptPartial:false,createdAt:1100,updatedAt:2500,completedAt:2500}]]);
  const store={get:(k,id)=>structuredClone(data.get(k+':'+id)),put:(k,id,v)=>data.set(k+':'+id,structuredClone(v)),list:k=>[...data].filter(([key])=>key.startsWith(k+':')).map(([,v])=>structuredClone(v)),flush(){}};
  const calls=[];const transcriptions={active:null,async action(id,action){calls.push({id,action});const v=store.get('transcription',id);v.status='cancelled';v.transcriptPartial=true;store.put('transcription',id,v);}};
  const options={store,directory:dir,search:{active:null},browser:{close(){}},transcriptions,ai:{chat(){throw Error('Manual clone must not call AI');}}};
  const studio=new sandbox.ContentStudio(options);return {studio,store,calls,options};
}

test('视频号克隆直接复用已采集说明，不自动开始转录或重新获取原视频',async t=>{
 const f=fixture(t);const item={id:'collected',platform:'视频号',type:'video',title:'已采集标题',text:'已采集原说明',bodyComplete:true,images:[],url:'https://channels.weixin.qq.com/web/pages/feed?oid=collected'};
 f.studio.search.item=()=>({item});f.studio.transcriptions.start=()=>{throw Error('不应重复获取素材');};const d=await f.studio.cloneFlow('record','collected',{autoCreate:false});
 assert.equal(d.status,'draft');assert.equal(d.original.text,item.text);assert.equal(d.body,item.text);assert.equal(d.transcriptionId,undefined);
 f.studio.videoFrames=()=>{throw Error('自动二创不应下载视频');};f.studio.ai={config:()=>({hasKey:true})};f.studio.remix=async()=>f.studio.get(d.id);assert.equal((await f.studio.autoRemix(d.id,'')).id,d.id);
});
test('旧的失败任务可回到已采集说明；保留手工文案，不产生新转录',async t=>{
 const f=fixture(t,'failed',{source:{type:'video',platform:'视频号',text:'已有作品说明'},body:'手工修改'});f.studio.transcriptions.start=()=>{throw Error('Must not request source');};const d=await f.studio.useCollected('d');assert.equal(d.status,'draft');assert.equal(d.original.text,'已有作品说明');assert.equal(d.body,'手工修改');assert.equal(d.originalTextKind,'description');
});
test('按需提取口播优先复用媒体库文件，完成后更新原文且保留说明',t=>{
 const f=fixture(t,'ready',{status:'draft',transcriptionId:null,source:{id:'same',platform:'视频号',type:'video',url:'https://channels.weixin.qq.com/web/pages/feed?oid=same'},body:'作品说明',original:{title:'视频',text:'作品说明'}});const file=path.join(f.studio.directory,'existing.mp4');fs.writeFileSync(file,'fixture');f.store.put('media','m',{platform:'视频号',sourceId:'same',filePath:file});
 f.studio.transcriptions.choose=p=>{assert.equal(p,file);return {id:'input'};};f.studio.transcriptions.start=p=>{assert.equal(p.inputId,'input');assert.equal(p.url,undefined);return {id:'t'};};const d=f.studio.extractTranscript('d');assert.equal(d.status,'draft');assert.equal(d.original.description,'作品说明');assert.equal(d.original.text,'已取得的原视频口播。');assert.equal(d.body,d.original.text);
});
test('停止后提取关键帧也必须复用已下载视频，不重新解析或下载',async t=>{
 const f=fixture(t,'cancelled',{status:'needs-action'}),file=path.join(f.studio.directory,'downloaded.mp4');fs.writeFileSync(file,'fixture');const tr=f.store.get('transcription','t');tr.sourceFile=file;f.store.put('transcription','t',tr);f.studio.transcriptions.engine={parse:()=>{throw Error('Must not re-fetch');}};assert.equal(await f.studio.originalMedia(f.studio.get('d'),new AbortController().signal),file);
});
for(const status of ['ready','archived','completed'])test(`完成状态 ${status} 回填原文、解锁且重复读取不改版本`,t=>{
  const f=fixture(t,status),d=f.studio.get('d');assert.equal(d.status,'draft');assert.equal(d.original.text,'已取得的原视频口播。');assert.equal(d.body,d.original.text);assert.equal(d.transcriptPartial,false);assert.equal(f.studio.get('d').revision,d.revision);
});
test('恢复已完成转录不得覆盖已有手工正文',t=>{const f=fixture(t,'ready',{body:'手工整理过的正文'});const d=f.studio.get('d');assert.equal(d.original.text,'已取得的原视频口播。');assert.equal(d.body,'手工整理过的正文');});
for(const status of ['interrupted','failed','cancelled','no-speech'])test(`${status} 不再无限转圈，已取得部分原文保留`,t=>{
  const f=fixture(t,status);const tr=f.store.get('transcription','t');tr.transcriptPartial=true;f.store.put('transcription','t',tr);const d=f.studio.get('d');assert.notEqual(d.status,'transcribing');
});
test('停止仅取消本稿关联转录，保存部分内容并立即退出运行状态',async t=>{
  const f=fixture(t,'transcribing');await f.studio.cancel('d');assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,'t');assert.notEqual(f.studio.get('d').status,'transcribing');
});
test('转录记录丢失也必须结束等待',t=>{const f=fixture(t);const d=f.store.get('content-draft','d');d.transcriptionId='missing';d.status='transcribing';f.store.put('content-draft','d',d);assert.equal(f.studio.get('d').status,'needs-action');});
test('等待中的原文与成稿同步显示；结束时间来自转录记录且重启保持不变',t=>{
  const f=fixture(t,'transcribing');let tr=f.store.get('transcription','t');tr.transcriptPartial=true;f.store.put('transcription','t',tr);
  const partial=f.studio.get('d');assert.equal(partial.original.text,tr.transcript);assert.equal(partial.body,tr.transcript);assert.equal(partial.transcriptPartial,true);assert.equal(partial.extractionProgress.running,true);
  tr.status='ready';tr.transcriptPartial=false;f.store.put('transcription','t',tr);const done=f.studio.get('d');assert.equal(done.extractionProgress.endedAt,2500);
  const restarted=new sandbox.ContentStudio(f.options).get('d');assert.equal(restarted.extractionProgress.startedAt,1000);assert.equal(restarted.extractionProgress.endedAt,2500);assert.equal(restarted.extractionProgress.running,false);
});
test('已完成但空转录不能伪装成成功或继续无限等待',t=>{const f=fixture(t,'ready');const tr=f.store.get('transcription','t');tr.transcript='';f.store.put('transcription','t',tr);assert.equal(f.studio.get('d').status,'needs-action');});

test('重复点击同一作品打开已有稿件，不新建、不再次调用二创模型',async t=>{
  const f=fixture(t,'ready');const d=f.store.get('content-draft','d');d.source.id='same';f.store.put('content-draft','d',d);f.studio.search.item=()=>({item:{id:'same',platform:'YouTube'}});
  let clones=0,remixes=0;f.studio.clone=async()=>{clones++;return f.studio.get('d');};f.studio.autoRemix=async()=>{remixes++;return f.studio.get('d');};
  const opened=await f.studio.cloneFlow('other-record','same',{autoCreate:true});assert.equal(opened.id,'d');assert.equal(clones,0);assert.equal(remixes,0);
});

test('同一作品正在处理时允许重新进入任务，保持正在执行的处理',async t=>{
  const f=fixture(t,'transcribing');const d=f.store.get('content-draft','d');d.source.id='same';f.store.put('content-draft','d',d);f.studio.search.item=()=>({item:{id:'same',platform:'YouTube'}});const active=new AbortController();f.studio.active=active;
  const opened=await f.studio.cloneFlow('record','same');assert.equal(opened.id,'d');assert.equal(f.studio.active,active);assert.equal(opened.status,'transcribing');
});
