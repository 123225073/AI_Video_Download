import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentSearch} from '../electron/content-search.js';
import {contentItem} from '../electron/content-data.js';
const options={limit:50,from:'2026-09-09',to:'2026-10-09'};
const item=contentItem('YouTube',{id:'abcdefghijk',url:'https://www.youtube.com/watch?v=abcdefghijk',title:'乒乓球',publishedAt:'2026-10-01'});
test('搜索开始立即切换关键词，首批结果在整次读取结束前可见，取消保留首批',async()=>{
  let release,emit;const gate=new Promise(r=>release=r),events=[];const records=new Map();
  const search=new ContentSearch({accounts:{active:()=>null},creators:{progress:()=>null},userSearch:{active:null},store:{get:(_k,id)=>records.get(id),put:(_k,id,v)=>records.set(id,structuredClone(v)),flush(){}},browser:{close(){},async read(_r,signal,_initial,onProgress){emit=onProgress;await gate;signal.throwIfAborted();return {items:[item]};}},changed(){if(search?.record)events.push(structuredClone(search.view()));}});
  search.record={id:'old',platform:'YouTube',keyword:'减肥',options,all:[],status:'ready'};
  const pending=search.start('YouTube','乒乓球',options);await new Promise(r=>setImmediate(r));
  assert.equal(events.at(-1)?.keyword,'乒乓球');assert.equal(events.at(-1)?.items.length,0);
  assert.equal(typeof emit,'function');emit({items:[item]});
  assert.equal(search.view().busy,true);assert.equal(events.at(-1).items.length,1);
  search.cancel();release();await assert.rejects(pending);assert.equal(search.view().items.length,1);assert.equal(search.view().status,'interrupted');
  assert.equal(records.get(search.record.id).all.length,1);
});
test('小红书日期核验与列表读取重叠；只用一个详情读取器，首次日期结果立即保存',async()=>{
  let release;const gate=new Promise(r=>release=r),records=new Map();let active=0,maxActive=0;
  const card=contentItem('小红书',{id:'abcdefabcdefabcdefabcdef',url:'https://www.xiaohongshu.com/explore/abcdefabcdefabcdefabcdef?xsec_token=test',title:'测试'});
  class Browser{close(){}show(){}async read(_r,_s,_i,progress){progress({items:[card]});await gate;return {items:[card]};}async detail(_item,_a,_s,opts){assert.deepEqual(opts,{metadataOnly:true,reuse:true});active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setImmediate(r));active--;return {...card,publishedAt:'2026-10-01',bodyComplete:false};}}
  const s=new ContentSearch({accounts:{active:()=>null},creators:{progress:()=>null},userSearch:{active:null},browser:new Browser(),store:{get:(_k,id)=>records.get(id),put:(_k,id,v)=>records.set(id,structuredClone(v)),flush(){}}});
  const pending=s.start('小红书','测试',options);await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  assert.equal(s.view().items.length,1);assert.equal(s.view().busy,true);assert.equal(records.get(s.record.id).all[0].publishedAt,'2026-10-01');assert.equal(maxActive,1);release();const r=await pending;assert.equal(r.items[0].publishedAt,'2026-10-01');
});
test('详情需要验证时停止采集并保留验证窗口，不能误报搜索成功',async()=>{
  let shown=0,closed=0;const card=contentItem('小红书',{id:'abcdefabcdefabcdefabcdef',url:'https://www.xiaohongshu.com/explore/abcdefabcdefabcdefabcdef',title:'测试'});
  class Browser{close(){closed++;}show(){shown++;}async read(_r,_s,_i,progress){progress({items:[card]});await new Promise(r=>setImmediate(r));return {items:[card]};}async detail(){throw Error('请在官方窗口完成登录或验证');}}
  const s=new ContentSearch({accounts:{active:()=>null},creators:{progress:()=>null},userSearch:{active:null},browser:new Browser(),store:{get(){},put(){},flush(){}}});const r=await s.start('小红书','测试',options);assert.equal(r.status,'needs-action');assert.ok(s.actionBrowser);assert.equal(shown,1);const before=closed;s.cancel();assert.equal(s.actionBrowser,null);assert.ok(closed>before);
});
