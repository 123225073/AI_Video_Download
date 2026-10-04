// Uses only the already-confirmed collector policy, never AI or platform credential files.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';import init from 'sql.js';
import {Store} from '../electron/store.js';import {CollectorConnection} from '../electron/collector-connection.js';import {WeChatCreators} from '../electron/wechat-creators.js';import {WeChat} from '../electron/wechat.js';import {Engine,command} from '../electron/engine.js';
const require=createRequire(import.meta.url),root=path.resolve('.'),userData=path.resolve(process.argv[2]),source=process.argv[3];
const output=path.resolve('output',`collector-live-${Date.now()}`),store=await Store.open(output,{}),controller=new AbortController();
const SQL=await init({wasmBinary:fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))}),db=new SQL.Database(fs.readFileSync(path.join(userData,'library.sqlite')));
for(const [kind,id] of [['collector-policy','automatic'],['collector-config','wechat']]){const s=db.prepare('SELECT data FROM records WHERE kind=? AND id=?');s.bind([kind,id]);if(s.step())store.put(kind,id,JSON.parse(s.getAsObject().data));s.free();}db.close();
assert.equal(store.get('collector-policy','automatic')?.allowed,true,'No previous explicit collector consent');
const connection=new CollectorConnection(store,path.join(root,'bin'),path.join(userData,'视频号连接'),()=>{const s=connection.status();if(s.label!==lastLabel){lastLabel=s.label;console.log(JSON.stringify({phase:s.phase,label:s.label}));}},{consent:async()=>true,waitMs:180000});let lastLabel='';
const wechat=new WeChat(null,path.join(root,'bin')),engine=new Engine(path.join(root,'bin'),null,wechat),collector=new WeChatCreators(store,engine);wechat.collector=collector;wechat.connection=connection;
const result={output,realWechat:true,ok:false},timer=setTimeout(()=>controller.abort(),360000);process.on('SIGINT',()=>controller.abort());
try{
 const before=await connection.system('inspect');await connection.recover();
 await connection.withConnection(controller.signal,async()=>{
   const creator=await collector.identify(source,null,controller.signal);result.author={name:creator.name,id:creator.id,hasAvatar:Boolean(creator.avatar)};console.log(JSON.stringify({author:creator.name,identified:true}));
   const page=await collector.page(creator,5,controller.signal);result.items=page.items.map(i=>({id:i.sourceId,title:i.title,hasCover:Boolean(i.thumbnail),hasShareUrl:Boolean(i.url)}));result.total=page.total;result.hasMore=!page.complete;assert.ok(page.items.length,'No videos returned');
   const media=await engine.download({id:randomUUID(),item:page.items[0],options:{quality:'best',force:false}},path.join(output,'下载验证'),controller.signal,()=>{});
   await command(path.join(root,'bin/ffmpeg/ffmpeg.exe'),['-v','error','-xerror','-i',media.filePath,'-f','null','-'],{signal:controller.signal});result.download=media;result.fullMediaDecode=true;
 });
 assert.deepEqual((await connection.system('inspect')).proxy,before.proxy);result.originalProxyRestored=true;result.ok=true;
}catch(error){result.error=error.message;process.exitCode=1;}
finally{clearTimeout(timer);await connection.close().catch(e=>result.restoreError=e.message);store.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
