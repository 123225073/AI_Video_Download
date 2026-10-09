import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import vm from 'node:vm';import {randomUUID} from 'node:crypto';
import {buildAssetPairs} from '../electron/remix-policy.js';
const sandbox={fs,path,randomUUID,Buffer,URL,Response,AbortController,AbortSignal,fetch,buildAssetPairs};vm.createContext(sandbox);vm.runInContext(fs.readFileSync('electron/content-studio.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.ContentStudio=ContentStudio',sandbox);const {ContentStudio}=sandbox;
test('克隆正文与首张图片应在下一张图片仍等待时持续可见，取消保留部分稿件',async()=>{
  const data=new Map(),events=[];let release;const gate=new Promise(r=>release=r);let calls=0;
  const item={id:'abcdefabcdefabcdefabcdef',platform:'小红书',type:'image',title:'标题',url:'https://www.xiaohongshu.com/explore/abcdefabcdefabcdefabcdef',text:'完整原文',bodyComplete:true,images:['https://sns-webpic.xhscdn.com/1.png','https://sns-webpic.xhscdn.com/2.png']};
  const studio=new ContentStudio({directory:fs.mkdtempSync(path.join(os.tmpdir(),'fengsha-studio-')),store:{get:(_k,id)=>data.get(id),list:()=>[],put:(_k,id,v)=>data.set(id,structuredClone(v)),flush(){}},search:{item:()=>({item}),active:null},browser:{close(){}},ai:{},changed(){if(studio.progress?.())events.push(structuredClone(studio.progress()));},fetcher:async()=>{if(++calls===2)await gate;return new Response(new Uint8Array([1]));}});
  studio.writeImage=async(_b,file)=>fs.writeFileSync(file,'fixture');
  const pending=studio.clone('record',item.id);for(let i=0;i<20&&calls<2;i++)await new Promise(r=>setImmediate(r));
  const id=data.get('lastContentDraft')?.id;assert.ok(id,'克隆开始后应立即创建可查看稿件');assert.equal(studio.get(id).body,'完整原文');assert.equal(studio.get(id).assets.length,1);assert.ok(events.length);studio.cancel();release();await assert.rejects(pending);assert.equal(studio.get(id).assets.length,1);assert.notEqual(studio.get(id).status,'draft');
});
