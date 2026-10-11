import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentSearch} from '../electron/content-search.js';
import {contentItem} from '../electron/content-data.js';
const options={limit:50,from:'2026-09-09',to:'2026-10-09'};
const card=contentItem('小红书',{id:'abcdefabcdefabcdefabcdef',url:'https://www.xiaohongshu.com/explore/abcdefabcdefabcdefabcdef',title:'测试'});
test('停止采集同时关闭正在补查日期的窗口，并立即保留结果和可继续状态',async()=>{
  let detailStarted,release;const started=new Promise(r=>detailStarted=r),gate=new Promise(r=>release=r),data=new Map();let detailClosed=false;
  class Browser{close(){if(this.isDetail){detailClosed=true;release();}}show(){}async read(r,s,initial,progress){progress({items:[card]});await started;return {items:[card]};}async detail(){this.isDetail=true;detailStarted();await gate;return {...card,publishedAt:'2026-10-01'};}}
  const search=new ContentSearch({accounts:{active:()=>null},creators:{progress:()=>null},userSearch:{active:null},browser:new Browser(),store:{get:(_k,id)=>data.get(id),put:(_k,id,v)=>data.set(id,structuredClone(v)),flush(){}}});
  const pending=search.start('小红书','测试',options);await started;search.cancel();
  try{assert.equal(detailClosed,true);assert.equal(search.view().status,'interrupted');assert.equal(search.view().canContinue,true);assert.equal(data.get(search.record.id).all.length,1);}finally{release();await pending.catch(()=>{});}
  assert.equal(search.view().unknown,1,'取消后的晚详情不能写回');assert.equal(search.view().busy,false);
});
