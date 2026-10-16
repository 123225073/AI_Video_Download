import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
import {searchUser} from '../electron/user-search-data.js';
import {thumbnailUrl} from '../electron/thumbnail.js';
import {youtubeCommentContext} from '../electron/youtube-session.js';

const selected='https://www.youtube.com/watch?v=vUno6VvDnGk';
const source=fs.readFileSync(new URL('../electron/comment-workflow.js',import.meta.url),'utf8');
function fixture(){
 const records=new Map(),reads=[],navigation=[];
 let current=selected,authenticated=false;
 const row={id:'existing',userId:'@known',name:'原评论者',text:'已保存评论'};
 const w={isDestroyed:()=>false,hide(){},show(){},focus(){},webContents:{getURL:()=>current,executeJavaScript:async()=>{
  reads.push(current);
  if(!authenticated)return {comments:[row],blocked:true,reason:'login',message:'请登录'};
  if(current!==selected)return {comments:[],blocked:true,message:'评论窗口已离开所选作品'};
  return {comments:[row,{id:'new',userId:'@next',name:'新评论者',text:'登录后新评论'}],complete:true};
 }},async loadURL(url){navigation.push(url);current=url;}};
 class Browser{
  constructor(){this.window=null;this.scope=null;}
  async open(url,record){this.window=w;this.scope=record;navigation.push(url);current=url;return w;}
  show(){}
  close(){this.window=null;}
 }
 const context={randomUUID,createHash,delay:async()=>{},searchUser,thumbnailUrl,ContentBrowser:Browser,AbortController,youtubeCommentContext};
 vm.createContext(context);vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+';globalThis.Workflow=CommentWorkflow;',context);
 const workflow=new context.Workflow({store:{get:(k,id)=>records.get(k+':'+id),put:(k,id,v)=>records.set(k+':'+id,structuredClone(v)),flush(){}},search:{active:null,item:()=>({item:{id:'vUno6VvDnGk',platform:'YouTube',url:selected},accountId:'selected-account'})},accounts:{active:()=>({id:'selected-account'})},changed(){}});
 return {workflow,reads,navigation,loginAt(url){authenticated=true;current=url;},url:()=>current};
}

for(const loginReturn of ['https://accounts.google.com/v3/signin/identifier','https://www.youtube.com/'])
 test('continuing collection from '+new URL(loginReturn).hostname+' restores selected video before reading',async()=>{
  const f=fixture();await f.workflow.start('search','vUno6VvDnGk',20);
  assert.equal(f.workflow.view().status,'needs-action');
  assert.equal(f.workflow.view().comments.length,1);
  f.loginAt(loginReturn);f.reads.length=0;f.navigation.length=0;
  await f.workflow.more(f.workflow.record.id,20);
  assert.equal(f.url(),selected);
  assert.deepEqual(f.navigation,[selected]);
  assert.deepEqual(f.reads,[selected]);
  assert.equal(f.workflow.view().status,'complete');
  assert.deepEqual([...f.workflow.view().comments].map(c=>c.id),['existing','new']);
 });

test('continuing on another video never merges that video or discards saved selected-video comments',async()=>{
 const f=fixture();await f.workflow.start('search','vUno6VvDnGk',20);
 f.loginAt('https://www.youtube.com/watch?v=qAZ5_RAm8-0');f.reads.length=0;f.navigation.length=0;
 await f.workflow.more(f.workflow.record.id,20).catch(()=>{});
 assert.equal(f.workflow.view().comments.length,1);
 assert.equal(f.workflow.view().comments[0].id,'existing');
 assert.notEqual(f.workflow.view().status,'complete');
 assert.deepEqual(f.navigation,[]);
});
