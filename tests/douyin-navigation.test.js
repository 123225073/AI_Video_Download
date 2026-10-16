import test from 'node:test';
import assert from 'node:assert/strict';
import {openDouyinSearch,selectDouyinWork,douyinWorkIdentity} from '../electron/douyin-navigation.js';

const id='7695717380512599330',item={platform:'抖音',id,title:'精确的作品标题',url:`https://www.douyin.com/video/${id}`};
const signal=()=>new AbortController().signal;
function fixture(states,actions={}){
 const calls=[];let cursor=0;
 const tab={send:async(method,p)=>{calls.push({method,...p});}};
 const window={externalTab:tab,isDestroyed:()=>false,show:()=>calls.push({show:true}),webContents:{executeJavaScript:async code=>{
  calls.push({evaluate:code});
  if(code.includes('function douyinVisibleState'))return states[Math.min(cursor++,states.length-1)];
  if(code.includes('function douyinVisibleAction'))return actions.select??{found:true,x:20,y:30};
  throw Error('Unexpected expression');
 }}};
 return {window,calls};
}
const homepage={official:true,path:'/jingxuan',ready:'complete',searchReady:true,searchValue:'',activeId:null,modalId:null};
const searched={...homepage,path:'/jingxuan/search/AI',searchKeyword:'AI',searchType:'general',searchValue:'AI'};
const selected={...searched,modalId:id,activeId:id};
test('external search uses homepage and visible UI, waits for SPA initialization, and never loads a constructed search URL',async()=>{
 const {window,calls}=fixture([homepage,homepage,homepage,homepage,homepage,homepage,searched]);
 const navigated=[];let waits=0;
 await openDouyinSearch(window,'AI',signal(),{restart:true,navigate:async u=>navigated.push(u),wait:async()=>{waits++;}});
 assert.deepEqual(navigated,['https://www.douyin.com/']);assert.ok(waits>=4);
 assert.ok(calls.some(c=>c.method==='Input.insertText'&&c.text==='AI'));
 assert.ok(calls.some(c=>c.method==='Input.dispatchMouseEvent'&&c.type==='mouseReleased'));
});
test('official verification leaves the owned page visible and does not submit another search',async()=>{
 const {window,calls}=fixture([{...homepage,blocked:true,message:'请完成官方验证'}]);
 await assert.rejects(openDouyinSearch(window,'AI',signal(),{wait:async()=>{}}),e=>e.needsAction&&e.keepWindow&&/验证/.test(e.message));
 assert.ok(calls.some(c=>c.show));assert.equal(calls.filter(c=>c.method).length,0);
});
test('resume on the same keyword search preserves its existing official context',async()=>{
 const {window,calls}=fixture([searched]);
 await openDouyinSearch(window,'AI',signal(),{navigate:async()=>assert.fail('must not reload'),wait:async()=>{}});
 assert.equal(calls.filter(c=>c.method).length,0);
});
test('selected work must match both the official modal URL and the active video ID',()=>{
 assert.equal(douyinWorkIdentity(selected,id),true);
 for(const state of [{...selected,activeId:'12345'},{...selected,modalId:'12345'},{...selected,modalId:null},{...selected,official:false}])assert.equal(douyinWorkIdentity(state,id),false);
});
test('exact selection reuses only its supplied owned tab and checks identity after the visible click',async()=>{
 const {window,calls}=fixture([searched,selected]);
 assert.equal(await selectDouyinWork(window,item,signal(),{wait:async()=>{}}),window);
 assert.ok(calls.some(c=>c.method==='Input.dispatchMouseEvent'));
});
test('missing or ambiguous exact card pauses; no first-result fallback or navigation',async()=>{
 for(const reason of ['missing','ambiguous']){
  const {window,calls}=fixture([searched],{select:{found:false,reason}});
  await assert.rejects(selectDouyinWork(window,item,signal(),{wait:async()=>{}}),e=>e.keepWindow&&e.needsAction);
  assert.equal(calls.filter(c=>c.method).length,0);
 }
});
test('a different opened work cannot be read and no selection is attempted behind its modal',async()=>{
 const {window,calls}=fixture([{...selected,modalId:'12345',activeId:'12345'}]);
 await assert.rejects(selectDouyinWork(window,item,signal(),{wait:async()=>{}}),/其他作品/);
 assert.equal(calls.filter(c=>c.method).length,0);
});
test('a wrong video opened by a matching title is rejected before comments can be read',async()=>{
 const {window}=fixture([searched,{...selected,activeId:'12345',modalId:'12345'}]);
 await assert.rejects(selectDouyinWork(window,item,signal(),{wait:async()=>{}}),/不一致/);
});
test('embedded windows, malformed IDs and mismatched canonical links are rejected without interaction',async()=>{
 await assert.rejects(openDouyinSearch({isDestroyed:()=>false},'AI',signal()),/外置/);
 const {window,calls}=fixture([searched]);
 await assert.rejects(selectDouyinWork(window,{...item,url:'https://www.douyin.com/video/12345'},signal()),/作品/);
 assert.equal(calls.length,0);
});
