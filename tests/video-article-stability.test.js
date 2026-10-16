import test from 'node:test';
import assert from 'node:assert/strict';
import {createStableVideoArticle as createVideoArticle} from '../electron/video-article.js';

test('事实校验发现改反原意时，自动修正并重新核验后完成，不把异常交给用户重试',async()=>{
 const source={title:'应用工具',text:'你原来不是这行业，你现在进也进不去。人与AI之间的关系可能未来是最值钱的东西。'};
 const plan=text=>({title:'应用工具',styleDescription:'统一纸卡',pages:['应用','关系','结论'].map((title,index)=>({title,text:index===0?text:index===1?'人与AI之间的关系可能未来是最值钱的东西。':'结合原文理解。',imagePrompt:'纸卡说明图，不增加新事实'}))});
 let audits=0,repairs=0;
 const ai={config:()=>({protocol:'chat'}),chat:async(system,content,signal,onText)=>{
  if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return JSON.stringify(++audits===1?{faithful:false,issues:['第1页把“进也进不去”改为“能轻易进入”，改变原结论。']}:{faithful:true,issues:[]});
  if(system.includes('VIDEO_ARTICLE_REPAIR')){repairs++;return JSON.stringify({page:plan(source.text).pages[0]});}
  const reply=JSON.stringify(plan('用了AI就能轻易进入原来不熟悉的行业。'));onText?.(reply);return reply;
 }};
 const result=await createVideoArticle({ai,source});
 assert.match(result.pages[0].text,/进也进不去/);assert.equal(audits,2);assert.equal(repairs,1);
});

const source={title:'使用工具',text:'先明确目标，再使用工具。'};
const pages=['目标','做法','结尾'].map(title=>({title,text:source.text,imagePrompt:'统一纸卡场景，不新增事实'}));
const full=()=>({title:source.title,pages:structuredClone(pages),styleDescription:'统一纸卡'});
const goodAudit='{"faithful":true,"issues":[]}';

test('流式输出超时后在同一操作中自动补齐剩余页，不重写已完成页',async()=>{
 let writes=0,continuations=0,saved;
 const ai={config:()=>({protocol:'chat'}),chat:async(system,content,signal,onText)=>{
  if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return goodAudit;
  if(system.includes('VIDEO_ARTICLE_CONTINUE_PAGE'))return JSON.stringify({page:pages[++continuations],styleDescription:'统一纸卡'});
  writes++;onText('{"title":"使用工具","pages":['+JSON.stringify(pages[0])+',{"title":"做法","text":"先明确');throw Error('模型服务超时');
 }};
 const result=await createVideoArticle({ai,source,options:{pageCount:3},retryDelayMs:0,onRecovery:r=>saved=r});
 assert.equal(writes,1);assert.equal(continuations,2);assert.deepEqual(result.pages.map(p=>p.text),pages.map(p=>p.text));assert.ok(saved.candidate.contentComplete);
});

test('复核服务超时和坏JSON自动重做复核，不重新生成正文',async()=>{
 let audits=0,writes=0;
 const ai={config:()=>({protocol:'chat'}),chat:async system=>{
  if(system.includes('VIDEO_ARTICLE_FACT_AUDIT')){audits++;if(audits===1)throw Error('模型服务超时');if(audits===2)return 'not-json';return goodAudit;}
  writes++;return JSON.stringify(full());
 }};
 await createVideoArticle({ai,source,retryDelayMs:0});assert.equal(writes,1);assert.equal(audits,3);
});

test('旧版事实失败候选继续时直接修正问题页，其他页保持不变',async()=>{
 let repairs=0,audits=0;
 const candidate=full();candidate.contentComplete=true;candidate.pages[1].text='错误的内容';
 const ai={config:()=>({protocol:'chat'}),chat:async(system,content)=>{
  if(system.includes('VIDEO_ARTICLE_FACT_AUDIT')){audits++;return goodAudit;}
  assert.match(system,/VIDEO_ARTICLE_REPAIR/);assert.equal(JSON.parse(content).pendingPage,2);repairs++;return JSON.stringify({page:pages[1]});
 }};
 const result=await createVideoArticle({ai,source,recovery:{candidate,validationIssues:{numericIssues:[],auditIssues:['第2页改动了原结论']}}});
 assert.equal(repairs,1);assert.equal(audits,1);assert.deepEqual(result.pages.map(p=>p.text),pages.map(p=>p.text));
});

test('持续事实错误最多自动修正两轮，始终不保存错误稿，不启动图片请求',async()=>{
 let repairs=0,checkpoints=0;
 const ai={config:()=>({protocol:'chat'}),chat:async system=>{
  if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return '{"faithful":false,"issues":["第1页改变原结论"]}';
  if(system.includes('VIDEO_ARTICLE_REPAIR')){repairs++;return JSON.stringify({page:pages[0]});}return JSON.stringify(full());
 }};
 await assert.rejects(createVideoArticle({ai,source,onCheckpoint:()=>checkpoints++}),e=>e.code==='VIDEO_ARTICLE_FACTS_CHANGED'&&e.partial===undefined&&e.recoveryAttempts.repairs===2);
 assert.equal(repairs,2);assert.equal(checkpoints,0);
});

test('持续网络故障最多恢复两次，密钥错误直接停止',async()=>{
 for(const [message,status,expected] of [['模型服务超时',undefined,3],['模型服务限流或额度不足，请稍后重试',429,3],['模型密钥无效，请重新配置',401,1]]){
  let calls=0;const ai={config:()=>({protocol:'chat'}),chat:async()=>{calls++;throw Object.assign(Error(message),{status});}};
  await assert.rejects(createVideoArticle({ai,source,retryDelayMs:0}));assert.equal(calls,expected);
 }
});

test('自动恢复等待期间可以停止，不再发起下一次请求',async()=>{
 const controller=new AbortController();let calls=0;
 const ai={config:()=>({protocol:'chat'}),chat:async()=>{calls++;throw Error('模型服务超时');}};
 await assert.rejects(createVideoArticle({ai,source,signal:controller.signal,onPreview:p=>{if(p.recovering)controller.abort();}}),e=>e.name==='AbortError');assert.equal(calls,1);
});

test('配图请求失败不进入文本自动恢复循环',async()=>{
 let writes=0,images=0;const ai={config:kind=>kind==='image'?{hasKey:true,model:'gpt-image-2.5-sunburst',baseUrl:'https://cpa.fengsha.online/v1',timeout:30}:{protocol:'chat'},secret:()=> 'test-only',chat:async system=>{
  if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return goodAudit;writes++;return JSON.stringify(full());
 }};
 await assert.rejects(createVideoArticle({ai,source,directory:'output/repair-087/not-created',options:{generateImages:true},fetcher:async()=>{images++;throw Error('模型服务超时');}}));assert.equal(images,1);assert.equal(writes,1);
});

test('修正多页期间超时，仅重做未修完的页',async()=>{
 const candidate=full();candidate.contentComplete=true;const indices=[];let saved;
 const ai={config:()=>({protocol:'chat'}),chat:async(system,content)=>{
  if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return goodAudit;
  const index=JSON.parse(content).pendingPage;indices.push(index);if(indices.length===2)throw Error('模型服务超时');return JSON.stringify({page:pages[index-1]});
 }};
 await createVideoArticle({ai,source,retryDelayMs:0,recovery:{candidate,validationIssues:{numericIssues:[],auditIssues:['第1页与第2页均有原意差异']}},onRecovery:r=>saved=r});
 assert.deepEqual(indices,[1,2,2]);assert.equal(saved.candidate.contentComplete,true);
});

test('错误页数重新取得合法结构；错误复核格式只重试复核',async()=>{
 let writes=0,audits=0;const ai={config:()=>({protocol:'chat'}),chat:async system=>{
  if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return ++audits===1?'{"faithful":"true","issues":[]}':goodAudit;
  const a=full();if(++writes===1)a.pages=a.pages.slice(0,2);return JSON.stringify(a);
 }};
 await createVideoArticle({ai,source,retryDelayMs:0});assert.equal(writes,2);assert.equal(audits,2);
});
