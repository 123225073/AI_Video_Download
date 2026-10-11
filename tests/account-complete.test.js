import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import * as cookies from '../electron/account-session.js';
const sandbox={fs,path,randomUUID,...cookies};vm.createContext(sandbox);vm.runInContext(fs.readFileSync('electron/accounts.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.AccountManager=AccountManager',sandbox);
test('小红书访客Cookie不能点击完成后被标记成已保存登录会话',async()=>{
  const a={id:'a',platform:'小红书',status:'登录中'},records=new Map([['a',a]]);let persisted=false,closed=false;
  const m=new sandbox.AccountManager({get:(_k,id)=>records.get(id),put:(_k,id,v)=>records.set(id,v),flush(){}},'unused',()=>{});
  m.getSession=()=>({cookies:{flushStore:async()=>{},get:async()=>[{domain:'.xiaohongshu.com',name:'a1',value:'synthetic-visitor'}]}});m.persist=async()=>{persisted=true;};m.windows.set('a',{isDestroyed:()=>false,webContents:{executeJavaScript:async()=>({loggedIn:false,blocked:true,reason:'device-limit',message:'电脑设备登录超限，请重新登录'})},close(){closed=true;}});
  await assert.rejects(m.complete('a'),/登录超限|完成.*登录/);assert.equal(records.get('a').lastSync,undefined);assert.equal(persisted,false);assert.equal(closed,false);
});

test('启动恢复不能用旧备份覆盖持久化浏览器中更新的登录Cookie',async()=>{
  const a={id:'a',platform:'小红书',status:'会话已保存',lastSync:1},records=new Map([['a',a]]),sets=[];
  const m=new sandbox.AccountManager({list:()=>[a],get:(_k,id)=>records.get(id),put:(_k,id,v)=>records.set(id,v),flush(){}},'unused',()=>{});
  m.getSession=()=>({cookies:{get:async()=>[{domain:'.xiaohongshu.com',path:'/',name:'web_session',value:'synthetic-new'}],set:async c=>sets.push(c)}});
  const originalFs=sandbox.fs;sandbox.fs={existsSync:()=>true,readFileSync:()=>Buffer.from('fixture')};sandbox.safeStorage={decryptString:()=>JSON.stringify([{domain:'.xiaohongshu.com',path:'/',name:'web_session',value:'synthetic-old'}])};
  try{await m.restore();assert.equal(sets.length,0,'原生持久化Cookie优先，不能退回旧登录令牌');}finally{sandbox.fs=originalFs;}
});
