import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));

test('作品页微信等待只作用于当前操作，已有内容按钮可结束等待并给出结果', {timeout:120000}, async t=>{
  const bundled=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import ContentPage from './src/ContentPage.jsx';
    const root=createRoot(document.getElementById('root'));let key=0;
    const draft=()=>({id:'saved-draft',revision:3,createdAt:1,status:'draft',title:'上次保存的稿件',body:'已有正文',tags:'',visibility:'private',source:{id:'old-source',platform:'视频号',text:'上次采集的文案',type:'video',title:'上次保存的稿件'},original:{text:'上次采集的文案'},assetOrder:[],assets:[]});
    const record=options=>({id:'search-current',platform:'视频号',keyword:'AI',options:{limit:50,from:'2026-01-01',to:'2026-10-16',includeUnknown:true},busy:true,items:options.items||[],scanned:options.items?.length||0,unknown:0,status:'searching',message:'正在等待微信连接'});
    function Fixture({options}){
      const initial=options.search===false?null:record(options);
      const [state,setState]=useState({accounts:[],contentSearch:initial,contentProgress:initial?{kind:'search'}:null,studioProgress:options.job||null,collectorConnection:{phase:'waiting',needsPage:true,label:'正在等候视频号连接',waitingUntil:Date.now()+90000}});
      const d=options.draft===null?null:{...draft(),...options.draft};
      async function perform(method,...args){
        window.calls.push({method,args});
        if(method==='contentLast')return initial;
        if(method==='contentDraftLast'||method==='contentDraftGet')return d;
        if(method==='contentDrafts')return d?[{id:d.id,title:d.title,platform:'视频号',sourceId:d.source.id,status:d.status,createdAt:1}]:[];
        if(method==='commentsLast')return null;
        if(method==='collectorStatus')return {connected:false};
        if(method==='collectorOpenPage')return {attempted:true};
        if(method==='contentCancel'){
          if(window.failCancel)throw Error('停止失败，请重试');
          if(window.holdCancel)await new Promise(resolve=>window.releaseCancel=resolve);
          setState(old=>({...old,contentSearch:initial?{...initial,busy:false,status:'interrupted'}:null,contentProgress:null,collectorConnection:{phase:'idle'}}));return true;
        }
        if(method==='contentUseCollected'){
          if(window.failUse)throw Error('使用已采集内容失败，稿件保留');
          if(window.holdUse)await new Promise(resolve=>window.releaseUse=resolve);
          const next={...d,status:'draft',revision:d.revision+1,message:'已使用采集的作品说明'};
          setState(old=>({...old,studioProgress:null,collectorConnection:{phase:'idle'}}));return next;
        }
        throw Error('Unexpected fixture method '+method);
      }
      return <ContentPage state={state} perform={perform} safe={(...args)=>perform(...args).catch(()=>{})} accounts={()=>{}} settings={()=>{}} notify={message=>window.notices.push(message)}/>;
    }
    window.mountContent=(options={})=>{window.calls=[];window.notices=[];window.failCancel=false;window.holdCancel=false;window.failUse=false;window.holdUse=false;flushSync(()=>root.render(<Fixture key={++key} options={options}/>));};
  `},bundle:true,write:false,outfile:'content-connection-ui.js',format:'iife',define:{'import.meta.env.BASE_URL':'"./"'}});
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'}),args:['--disable-background-networking']});
  t.after(()=>browser.close());
  const context=await browser.newContext({offline:true,serviceWorkers:'block',viewport:{width:1280,height:900}});
  await context.route('**/*',route=>route.request().url()==='http://content-connection.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'}):route.abort());
  const page=await context.newPage();page.setDefaultTimeout(3000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://content-connection.test/');
  for(const file of bundled.outputFiles){if(file.path.endsWith('.css'))await page.addStyleTag({content:file.text});if(file.path.endsWith('.js'))await page.addScriptTag({content:file.text});}
  const mount=options=>page.evaluate(options=>window.mountContent(options),options);
  const button=name=>page.getByRole('button',{name,exact:true});
  const calls=()=>page.evaluate(()=>window.calls);
  await t.test('新搜索零条时，不得把旧稿的采集文案当成本次可用搜索结果',async()=>{
    await mount();await page.getByRole('dialog').waitFor();await page.getByText('我的克隆任务（1）',{exact:true}).waitFor({state:'attached'});
    assert.equal(await page.getByRole('dialog').getByRole('button',{name:/直接使用已采集内容|使用已采集的/}).count(),0);
    assert.match(await page.getByRole('dialog').innerText(),/尚未采集到作品/);
    assert.equal((await calls()).filter(c=>c.method==='contentUseCollected').length,0);
  });
  await t.test('搜索已有批次时，使用按钮停止搜索并保留当前列表，不操作旧稿',async()=>{
    const items=[1,2].map(n=>({id:'item-'+n,key:'key-'+n,title:'本次作品'+n,platform:'视频号',type:'video',url:'https://channels.weixin.qq.com/fixture'+n}));
    await mount({items});await button('使用已采集的 2 条作品').click();await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal((await calls()).filter(c=>c.method==='contentCancel').length,1);
    assert.equal((await calls()).filter(c=>c.method==='contentUseCollected').length,0);
    assert.equal(await page.getByText('本次作品1',{exact:true}).isVisible(),true);assert.equal(await page.getByText('本次作品2',{exact:true}).isVisible(),true);
  });
  await t.test('停止失败必须在弹窗内可见且可重试',async()=>{
    await mount({draft:null});await page.evaluate(()=>window.failCancel=true);await button('停止并保留已有结果').click();
    await page.getByRole('dialog').getByText('停止失败，请重试',{exact:true}).waitFor();
    assert.equal(await button('停止并保留已有结果').isEnabled(),true);await page.evaluate(()=>window.failCancel=false);await button('停止并保留已有结果').click();await page.getByRole('dialog').waitFor({state:'hidden'});
  });
  await t.test('本稿提取等待可直接使用已采集文案，错误可见并防止重复点击',async()=>{
    await mount({search:false,draft:{status:'transcribing'},job:{draftId:'saved-draft',running:true}});
    await page.evaluate(()=>window.failUse=true);await button('直接使用已采集内容').click();await page.getByRole('dialog').getByText('使用已采集内容失败，稿件保留',{exact:true}).waitFor();
    await page.evaluate(()=>{window.failUse=false;window.holdUse=true;});await button('直接使用已采集内容').click();await button('正在使用已有内容…').waitFor();assert.equal(await button('正在使用已有内容…').isDisabled(),true);
    await page.evaluate(()=>window.releaseUse());await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.getByRole('heading',{name:'单篇克隆与二创'}).isVisible(),true);
    assert.equal((await calls()).filter(c=>c.method==='contentUseCollected').length,2);
  });
  await t.test('其他稿件运行不因旧稿有文案而弹出连接操作',async()=>{
    await mount({search:false,job:{draftId:'another-draft',running:true}});await page.getByText('我的克隆任务（1）',{exact:true}).waitFor({state:'attached'});assert.equal(await page.getByRole('dialog').count(),0);
  });
  assert.deepEqual(errors,[]);
});
