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
