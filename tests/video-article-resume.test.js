import test from 'node:test';
import assert from 'node:assert/strict';
import {createVideoArticle} from '../electron/video-article.js';

const pages = ['开头','做法','结尾'].map(title=>({title,text:'先明确目标，再使用工具。',imagePrompt:'纸卡和工具的插画'}));
const source={title:'使用工具',text:'先明确目标，再使用工具。'};
test('长输出中断后保留完整页，继续只补余页并重新校验',async()=>{
  let saved, first=true, writes=0;
  const ai={config:()=>({protocol:'chat'}),chat:async(system,content,signal,onText)=>{
    if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return '{"faithful":true,"issues":[]}';
    if(first){first=false;onText('{"title":"使用工具","pages":['+JSON.stringify(pages[0])+',{"title":"做法","text":"先明确');throw Error('模型服务超时');}
    assert.match(system,/VIDEO_ARTICLE_CONTINUE_PAGE/);
    writes++;return JSON.stringify({page:pages[writes],done:writes===2,styleDescription:'统一纸卡插画'});
  }};
  await assert.rejects(createVideoArticle({ai,source,options:{pageCount:3},onRecovery:r=>saved=r}),/超时/);
  assert.ok(saved,'中断应保存可继续的结构化内容');
  const result=await createVideoArticle({ai,source,options:{pageCount:3},recovery:saved});
  assert.equal(writes,2);assert.deepEqual(result.pages.map(p=>p.text),pages.map(p=>p.text));
});
test('事实复核超时继续只重做复核，不重写已完成正文',async()=>{
  let saved,writes=0,audits=0;
  const ai={config:()=>({protocol:'chat'}),chat:async system=>{
    if(system.includes('VIDEO_ARTICLE_FACT_AUDIT')){if(++audits===1)throw Error('复核超时');return '{"faithful":true,"issues":[]}';}
    writes++;return JSON.stringify({title:'使用工具',pages,styleDescription:'纸卡插画'});
  }};
  await assert.rejects(createVideoArticle({ai,source,onRecovery:r=>saved=r}),/复核超时/);
  await createVideoArticle({ai,source,recovery:saved});
  assert.equal(writes,1);assert.equal(audits,2);
});

test('分页数组已闭合但外层JSON未收尾时，不重复新增一页',async()=>{
  let saved,writes=0;
  const ai={config:()=>({protocol:'chat'}),chat:async(system,content,signal,onText)=>{
    if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return '{"faithful":true,"issues":[]}';
    writes++;onText('{"title":"使用工具","pages":'+JSON.stringify(pages)+',"styleDescription":"插画');throw Error('超时');
  }};
  await assert.rejects(createVideoArticle({ai,source,onRecovery:r=>saved=r}),/超时/);
  const result=await createVideoArticle({ai,source,recovery:saved});assert.equal(writes,1);assert.equal(result.pages.length,3);
});
