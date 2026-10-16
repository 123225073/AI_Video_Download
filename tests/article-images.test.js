import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {prepareArticlePrompts,promptHash} from '../electron/article-prompts.js';
import {generateArticleImages} from '../electron/article-images.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWy0AAAAASUVORK5CYII=','base64');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'article-batch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const article=prepareArticlePrompts({title:'目标',body:'正文',pages:[1,2,3].map(i=>({id:'p'+i,index:i,title:'先确定目标',text:'先明确目标，再使用工具。',imagePrompt:'纸卡与工具'}))});return {article,directory,ai:{config:()=>({baseUrl:'https://cpa.fengsha.online/v1',model:'test',hasKey:true,timeout:30}),secret:()=> 'test-only'},imageDecoder:async()=>png};}
const response=()=>new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
test('逐图保存，失败不重试；下次跳过完成页，保留手改提示词',async t=>{
 const f=fixture(t);f.article.pages[1].generationPrompt+='\n保留手工修改';let calls=0,saved;
 await assert.rejects(generateArticleImages({...f,fetcher:async()=>++calls===2?new Response('{}',{status:503}):response(),onCheckpoint:r=>saved=r}),/HTTP 503/);
 assert.equal(calls,2);assert.equal(saved.generatedCount,1);const file=saved.pages[0].imageFile;
 calls=0;const done=await generateArticleImages({...f,article:saved,fetcher:async()=>{calls++;return response();}});
 assert.equal(calls,2);assert.equal(done.pages[0].imageFile,file);assert.match(done.pages[1].generationPrompt,/手工修改/);assert.equal(done.generatedCount,3);
 calls=0;await generateArticleImages({...f,article:done,fetcher:async()=>{calls++;return response();}});assert.equal(calls,0);
 done.pages[1].generationPrompt+='仅修改此页';calls=0;await generateArticleImages({...f,article:done,fetcher:async()=>{calls++;return response();}});assert.equal(calls,1);
});
test('更改统一画风影响整组，取消保留完成页且不请求下一张',async t=>{
 const f=fixture(t),controller=new AbortController();let calls=0,saved;
 await assert.rejects(generateArticleImages({...f,signal:controller.signal,fetcher:async()=>{calls++;return response();},onCheckpoint:r=>{saved=r;controller.abort();}}),/abort/i);
 assert.equal(calls,1);assert.ok(fs.existsSync(saved.pages[0].imageFile));assert.notEqual(promptHash(saved.imageStyle,saved.pages[0].generationPrompt),promptHash('新画风',saved.pages[0].generationPrompt));
});
test('断点文件丢失须重新生成，模型返回非法图像不得写成成功',async t=>{
 const f=fixture(t);let saved=await generateArticleImages({...f,fetcher:async()=>response()});fs.unlinkSync(saved.pages[0].imageFile);let calls=0;
 saved=await generateArticleImages({...f,article:saved,fetcher:async()=>{calls++;return response();}});assert.equal(calls,1);assert.equal(saved.generatedCount,3);
 let checkpoints=0;await assert.rejects(generateArticleImages({...f,fetcher:async()=>new Response('{"data":[{"b64_json":"bad"}]}'),onCheckpoint:()=>checkpoints++}),/base64/);assert.equal(checkpoints,0);
});
