import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {reloadTestRenderer} from './test-renderer.mjs';

const out = path.resolve('output', 'workspace-090-' + Date.now());
fs.mkdirSync(out, {recursive:true});
const env = {...process.env, FENGSHA_TEST_MODE:'1', FENGSHA_TEST_VISIBLE:'1', FENGSHA_TEST_DATA:path.join(out,'profile')};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({executablePath:createRequire(import.meta.url)('electron'), args:[path.resolve('.')], env});
  await reloadTestRenderer(app);
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const nav = name => page.locator('.sidebar').getByRole('button', {name,exact:true}).click();
  const screenshot = async name => {
    const pixels = await app.evaluate(async () => (await globalThis.fengshaTest.win.webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(pixels,'base64'));
  };
  await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();
  await page.getByRole('button',{name:'下载组件就绪'}).waitFor();
  await screenshot('下载工作台');
  await nav('评论与私信');
  await page.getByRole('button',{name:'前往作品搜索'}).click();
  await page.getByLabel('作品搜索关键词').fill('摄影');
  await nav('链接下载');
  await nav('作品搜索与二创');
  assert.equal(await page.getByLabel('作品搜索关键词').inputValue(),'摄影');
  await app.evaluate(() => {
    const t = globalThis.fengshaTest;
    const make = (id,title,createdAt) => ({id, createdAt, status:'complete', limit:50,
      source:{id:'source-'+id,platform:'小红书',title,url:'https://www.xiaohongshu.com/'},
      comments:[{id:'comment-'+id,name:'示例用户',text:'咨询拍摄时间',platform:'小红书'}]});
    const a = make('older','城市夜景摄影',1), b = make('newer','棚拍灯光技巧',2);
    for (const r of [a,b]) t.store.put('comment-collection',r.id,r);
    t.comments.record = b; t.comments.publish();
  });
  await nav('评论与私信');
  await page.getByLabel('选择历史评论记录').selectOption('older');
  await page.getByText('城市夜景摄影',{exact:true}).waitFor();
  await page.getByLabel('筛选评论与用户').fill('拍摄');
  assert.equal(await page.locator('.comment-row').count(),1);
  assert.equal(await app.evaluate(() => globalThis.fengshaTest.comments.active),null);
  await screenshot('评论工作台');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1080,720));
  for (const name of ['链接下载','博主批量下载','作品搜索与二创','评论与私信','任务中心','媒体库','文章中心','转录与翻译','账号管理','设置']) {
    await nav(name);
    assert.equal(await page.locator('.sidebar [aria-current="page"]').getAttribute('aria-label'),name);
    assert.ok(await page.locator('.main').evaluate(m => m.scrollWidth <= m.clientWidth+1), name+' 横向溢出');
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,output:out,navigation:10,history:true,searchPreserved:true,pageErrors:errors}));
} finally { await app?.close(); }
