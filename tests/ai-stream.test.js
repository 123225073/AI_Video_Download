import test from 'node:test';import assert from 'node:assert/strict';import {readTextStream,draftTextPreview} from '../electron/ai-stream.js';
test('SSE拆包、中文UTF8边界与CRLF保持文案增量，必须有完整结束事件',async()=>{
  const bytes=new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{content:'你好'},finish_reason:null}]})+'\r\n\r\ndata: '+JSON.stringify({choices:[{index:0,delta:{content:'，世界'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'),seen=[];
  const body=new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}});const text=await readTextStream(new Response(body),'chat',null,t=>seen.push(t));assert.equal(text,'你好，世界');assert.deepEqual(seen,['你好','你好，世界']);
  await assert.rejects(readTextStream(new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'未完成'}}]})+'\n\n'),'chat',null,()=>{}),/未完整/);
});
test('Responses只接收输出正文；失败／截断不能当作成功，不泄露上游错误',async()=>{
  const frame=d=>'data: '+JSON.stringify(d)+'\n\n';const text=await readTextStream(new Response(frame({type:'response.reasoning_summary_text.delta',delta:'思考'})+frame({type:'response.output_text.delta',output_index:0,content_index:0,delta:'正文'})+frame({type:'response.completed',response:{status:'completed'}})),'responses',null,()=>{});assert.equal(text,'正文');
  await assert.rejects(readTextStream(new Response(frame({error:{message:'PRIVATE-SECRET'}})),'chat',null,()=>{}),e=>!e.message.includes('PRIVATE-SECRET'));
  await assert.rejects(readTextStream(new Response(frame({choices:[{index:0,delta:{content:'片段'},finish_reason:'length'}]})),'chat',null,()=>{}),/未完整/);
});
test('流式结构化正文预览处理引号、换行、半个转义及思考标签',()=>{
  assert.equal(draftTextPreview('<think>秘密</think>{"title":"新标题","body":"第一段\\n第二段\\"引号\\"').body,'第一段\n第二段"引号"');
});
