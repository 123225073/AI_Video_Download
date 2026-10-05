import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
const output = path.resolve('output', `bilibili-e2e-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_VISIBLE: '1', FENGSHA_TEST_DATA: path.join(output, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
let app, page; const result = { output, ok: false, response: '模拟列表与详情；封面渲染单独验证' }, errors = [];
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve(process.argv[2] || '.')], env, timeout: 45000 });
  page = await app.firstWindow(); page.on('pageerror', e=>errors.push(e.message)); await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();
  await page.route('https://i2.hdslb.com/**', route=>route.fulfill({path:path.resolve('assets/icon.png'),contentType:'image/png'}));
  await app.evaluate(() => {
    const { engine } = globalThis.fengshaTest; engine.bilibili.interval=0;
    globalThis.biliTestCalls=[];
    engine.bilibili.request=async url=>{
      const u=new URL(url); globalThis.biliTestCalls.push(u.pathname+u.search);
      let data;
      if(u.pathname.endsWith('/nav'))data={wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}};
      else if(u.pathname.endsWith('/card'))data={card:{mid:'60542591',name:'B站隔离测试作者',face:'https://i2.hdslb.com/face.png'},archive_count:55};
      else if(u.pathname.endsWith('/view'))data={bvid:u.searchParams.get('bvid'),title:'已补全的真实字段结构',pic:'http://i2.hdslb.com/cover.jpg',duration:659,pubdate:1791028800,owner:{mid:60542591,name:'B站隔离测试作者'},pages:[{page:1,duration:659}]};
      else { const pn=Number(u.searchParams.get('pn')); data={page:{pn,ps:30,count:55},list:{vlist:Array.from({length:pn===1?30:25},(_,i)=>({bvid:'BV'+String((pn-1)*30+i+1).padStart(10,'0'),mid:60542591,title:`B站元数据作品${(pn-1)*30+i+1}`,author:'B站隔离测试作者',pic:'http://i2.hdslb.com/cover.jpg',length:'10:59',created:1791028800}))}}; }
      return {ok:true,status:200,json:async()=>({code:0,data})};
    };
  });
  await page.getByRole('button',{name:'博主批量下载',exact:true}).click();
  await page.getByLabel('博主链接').fill('https://space.bilibili.com/60542591/video'); await page.getByRole('button',{name:'识别博主',exact:true}).click();
  await page.getByRole('heading',{name:'B站隔离测试作者',exact:true}).waitFor();
  await page.getByLabel('作品读取数量').selectOption('100'); await page.getByRole('button',{name:'确认博主并读取作品'}).click();
  await page.getByText('已读取 55 条 · 筛选后 55 条',{exact:true}).waitFor();
  assert.equal(await page.locator('.creator-item').count(),55); assert.equal(await page.getByText('待获取标题',{exact:true}).count(),0); assert.equal(await page.getByText('时长待获取',{exact:false}).count(),0);
  await page.locator('.creator-item').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('.creator-item img')?.naturalWidth>0); result.richMetadata=true; result.coverRendered=true;
  const calls=await app.evaluate(()=>globalThis.biliTestCalls.filter(u=>u.includes('/arc/search')).map(u=>new URL('https://api.bilibili.com'+u).searchParams.get('pn'))); assert.deepEqual(calls,['1','2']); result.noRepeatedPage=true;
  await page.screenshot({path:path.join(output,'列表元数据与封面.png')});
  const id=await app.evaluate(()=>{const {creators,store}=globalThis.fengshaTest;const r=creators.last();r.items[0]={...r.items[0],title:'待获取标题',thumbnail:'',duration:null,publishedAt:null};store.put('creator',r.id,r);store.flush();return r.id;});
  await page.getByRole('button',{name:'补全作品信息',exact:true}).click(); await page.getByText('已补全的真实字段结构',{exact:true}).waitFor();
  assert.equal((await app.evaluate(()=>globalThis.fengshaTest.creators.last())).metadataPending,0); result.legacyRepair=true;
  const entry=path.resolve('cli/fengsha.mjs');
  const {spawnSync}=await import('node:child_process');
  const cli=spawnSync(process.execPath,[entry,'creator','--record',id,'--refresh','--data-dir',env.FENGSHA_TEST_DATA],{encoding:'utf8',env,windowsHide:true});
  assert.equal(cli.status,0,cli.stdout+cli.stderr);assert.equal(JSON.parse(cli.stdout).data.items.length,55);result.cliRepair=true;
  // A corrected cover URL must recover after an earlier image error.
  await app.evaluate(()=>{const {creators,store,win}=globalThis.fengshaTest;const r=creators.last();r.items[0]={...r.items[0],thumbnail:'https://i2.hdslb.com/broken.jpg'};store.put('creator',r.id,r);win.webContents.send('fengsha:creator-changed',r);});
  await page.unroute('https://i2.hdslb.com/**');
  await page.route('https://i2.hdslb.com/broken.jpg',route=>route.abort());
  await page.route('https://i2.hdslb.com/fixed.jpg',route=>route.fulfill({path:path.resolve('assets/icon.png'),contentType:'image/png'}));
  await page.waitForFunction(()=>!document.querySelector('.creator-item')?.querySelector('img'));
  await app.evaluate(()=>{const {creators,store,win}=globalThis.fengshaTest;const r=creators.last();r.items[0]={...r.items[0],thumbnail:'https://i2.hdslb.com/fixed.jpg'};store.put('creator',r.id,r);win.webContents.send('fengsha:creator-changed',r);});
  await page.waitForFunction(()=>document.querySelector('.creator-item img')?.naturalWidth>0);result.coverRecovery=true;
  await app.evaluate(()=>{const b=globalThis.fengshaTest.engine.bilibili;b.reset(globalThis.fengshaTest.creators.last().creator);b.request=async()=>({ok:false,status:412});});
  await page.getByRole('button',{name:'确认博主并读取作品'}).click();await page.getByText(/B站限制了作品列表请求/).waitFor();result.riskMessage=true;
  assert.equal(await page.locator('.creator-item').count(),55);result.failedResetKeepsList=true;
  assert.deepEqual(errors,[]);result.rendererErrors=errors;result.ok=true;
} catch(e) {result.error=String(e.stack||e);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally {await app?.close().catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
