import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/store.js';
import {Creators} from '../electron/creators.js';

async function fixture(){
  const directory=path.resolve('output/unit-history',randomUUID()),store=await Store.open(directory,{});
  const service=new Creators(store,{},null,()=>{});
  for(const id of ['first','last'])store.put('creator',id,{id,source:`https://example.test/${id}`,creator:{name:id},items:[{title:'saved list'}]});
  store.put('meta','lastCreator',{id:'last'});
  const kept=[['account','a',{id:'a',session:'fixture-session'}],['task','t',{id:'t',status:'completed'}],['media','m',{id:'m',filePath:path.join(directory,'download.mp4')}],['transcription','s',{id:'s',transcript:'saved transcript'}],['content-draft','d',{id:'d',body:'saved draft'}],['collector-config','wechat',{enabled:true}],['meta','unrelated',{value:'keep'}]];
  for(const [kind,id,data] of kept)store.put(kind,id,data);
  fs.writeFileSync(path.join(directory,'download.mp4'),'fixture-media');store.flush();
  return {directory,store,service,kept};
}
test('清除所有博主历史在重启后仍为空，其他账号、任务、资料和文件保持原样',async()=>{
  const {directory,store,service,kept}=await fixture();
  assert.deepEqual(service.clearHistory(),{cleared:true,count:2});
  assert.equal(service.last(),null);assert.deepEqual(store.list('creator'),[]);
  assert.deepEqual(service.clearHistory(),{cleared:true,count:0});store.close();
  const reopened=await Store.open(directory,{});
  assert.deepEqual(reopened.list('creator'),[]);assert.equal(reopened.get('meta','lastCreator'),null);
  for(const [kind,id,data] of kept)assert.deepEqual(reopened.get(kind,id),data);
  assert.equal(fs.readFileSync(path.join(directory,'download.mp4'),'utf8'),'fixture-media');reopened.close();
});
test('读取仍在运行时不能清除历史，已有清单不变',async()=>{
  const {store,service}=await fixture();service.active={label:'reading'};
  assert.throws(()=>service.clearHistory(),/停止.*读取|读取.*停止/);
  assert.equal(store.list('creator').length,2);assert.equal(service.last().id,'last');store.close();
});
