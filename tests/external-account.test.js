import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import * as cookies from '../electron/account-session.js';
import {externalLoginState} from '../electron/external-login.js';
import {externalApiSpec,externalPageFetch,abortableApi} from '../electron/external-account-api.js';

const source=fs.readFileSync(new URL('../electron/accounts.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(initial=[],options={}){
  const records=new Map(initial.map(a=>['account|'+a.id,plain(a)]));
  for(const a of initial)if(!records.has('active-account|'+a.platform))records.set('active-account|'+a.platform,{id:a.id});
  const calls=[],files=new Map(),sessions=new Map(),tabs=[];
  const store={get:(kind,id)=>records.has(kind+'|'+id)?plain(records.get(kind+'|'+id)):null,
    list:kind=>[...records].filter(([key])=>key.startsWith(kind+'|')).map(([,value])=>plain(value)),
    put:(kind,id,value)=>records.set(kind+'|'+id,plain(value)),flush(){},db:{run(_sql,[kind,id]){records.delete(kind+'|'+id);}}};
  const fakeFS={existsSync:file=>files.has(file),readFileSync:(file,encoding)=>{calls.push(['file-read',file]);if(!files.has(file))throw Error('Missing fixture file');return encoding?files.get(file).toString(encoding):files.get(file);},
    statSync:file=>({size:files.get(file)?.length||0}),mkdirSync(){},writeFileSync(file,value){calls.push(['file-write',file]);files.set(file,Buffer.from(value));},renameSync(from,to){files.set(to,files.get(from));files.delete(from);},unlinkSync(file){calls.push(['file-unlink',file]);files.delete(file);}};
  const sessionFor=id=>{
    if(sessions.has(id))return sessions.get(id);
    const current=[];
    const s={async fetch(url,options){calls.push(['native-fetch',url,options]);return {ok:true,status:200,json:async()=>({native:true})};},cookies:{values:current,on(){},async flushStore(){calls.push(['cookie-flush',id]);},async get(filter={}){calls.push(['cookie-read',id]);return current.filter(c=>!filter.name||c.name===filter.name);},async set(c){calls.push(['cookie-set',id]);current.push(c);}},
      setUserAgent(){},setPermissionRequestHandler(){},flushStorageData(){calls.push(['storage-flush',id]);},async clearStorageData(){calls.push(['storage-clear',id]);current.length=0;},async clearAuthCache(){calls.push(['auth-clear',id]);},async clearCache(){calls.push(['cache-clear',id]);}};
    sessions.set(id,s);return s;
  };
  class FakeWindow extends EventEmitter{
    constructor(options){super();this.options=options;this.destroyed=false;this.webContents={setWindowOpenHandler(){},on(){},executeJavaScript:async()=>({loggedIn:true})};calls.push(['embedded-window']);}
    isDestroyed(){return this.destroyed;}show(){}focus(){}async loadURL(url){calls.push(['embedded-load',url]);}close(){this.destroyed=true;this.emit('closed');}
  }
  const browser={loginState:{authenticated:null,message:'Chrome 已接入，平台登录尚待确认'},apiResponse:{status:200,ok:true,text:'{"code":0,"data":{"isLogin":true}}'},failOpen:null,
    async status(){return {available:true,message:'Chrome 已接入'};},
    async open(url,options){if(this.failOpen)throw Error(this.failOpen);calls.push(['chrome-open',url,plain(options)]);const tab={url,closed:false,async show(){calls.push(['chrome-show']);},async close(){this.closed=true;calls.push(['chrome-close']);},async evaluate(expression){calls.push(['chrome-evaluate',expression]);if(expression.includes('externalPageFetch')){if(browser.holdApi)await new Promise(resolve=>browser.releaseApi=resolve);return browser.apiResponse;}return browser.loginState;}};tabs.push(tab);return tab;},
    async clearCookies(){throw Error('Must never clear Chrome cookies');},async exportCookies(){throw Error('Must never export Chrome cookies');}};
  const sandbox={fs:fakeFS,path,randomUUID,EventEmitter,...cookies,externalLoginState,externalApiSpec,externalPageFetch,abortableApi,Buffer,BrowserWindow:FakeWindow,
    session:{fromPath:directory=>sessionFor(path.basename(directory))},
    safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>{calls.push(['encrypt-internal']);return Buffer.from(value);},decryptString:value=>{calls.push(['decrypt-internal']);return value.toString();}},
    setTimeout,clearTimeout,AbortController};
  vm.createContext(sandbox);vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.AccountManager=AccountManager',sandbox);
  const manager=new sandbox.AccountManager(store,'fixture-accounts',()=>{}, {externalBrowser:browser,...options});
  return {manager,store,browser,calls,files,tabs,sessionFor,account:id=>store.get('account',id)};
}
const oldAccount=(platform='小红书',id='old')=>({id,platform,name:'原正常账号',status:'会话已保存',lastSync:100,lastVerified:200});
const credentials=calls=>calls.filter(([kind])=>/cookie-|storage-|encrypt|decrypt|file-write|file-unlink/.test(kind));

test('旧内部账号恢复不自动迁移，已有B站和视频号元宝用途不切到Chrome',async()=>{
  const f=fixture([oldAccount('B站','bili'),oldAccount('视频号','wechat'),oldAccount('小红书','xhs')]);
  await f.manager.restore();
  for(const id of ['bili','wechat','xhs']){const a=f.account(id);assert.equal(a.loginBackend,undefined);assert.equal(f.manager.usesExternal(a.platform,id),false);assert.equal(a.lastSync,100);assert.equal(a.lastVerified,200);}
  assert.equal(f.calls.some(([kind])=>kind==='chrome-open'),false);
  f.sessionFor('bili').cookies.values.push({domain:'.bilibili.com',path:'/',name:'SESSDATA',value:'synthetic-existing-bili',secure:true});
  assert.equal(await f.manager.bilibiliLoginReady('bili'),true,'原内置B站门禁仍能确认其自己的会话');
  const cookieFile=await f.manager.cookieFile('B站','bili');assert.ok(cookieFile);assert.match(f.files.get(cookieFile).toString(),/synthetic-existing-bili/);
});

test('已有内部账号打开Chrome后尚未确认时，不能提前切换现有正常采集路由',async()=>{
  const f=fixture([oldAccount()]);await f.manager.openExternalLogin('old');
  assert.equal(f.manager.usesExternal('小红书','old'),false,'仅打开Chrome标签不足以替代原已保存内部账号');
  f.browser.loginState={authenticated:false,message:'仍需完成官方登录'};
  const result=await f.manager.complete('old');assert.equal(result.verified,false);
  assert.equal(f.manager.usesExternal('小红书','old'),false,'待确认的Chrome不能覆盖原正常会话');
});

test('Chrome打开失败不修改旧账号标记、验证时间和内部备份',async()=>{
  const f=fixture([oldAccount()]),before=f.account('old');f.browser.failOpen='Chrome 当前未授权连接';
  const file=f.manager.backupFile('old');f.files.set(file,Buffer.from('synthetic-internal-backup'));const bytes=Buffer.from(f.files.get(file));
  await assert.rejects(f.manager.openExternalLogin('old'),/未授权/);assert.deepEqual(f.account('old'),before);assert.deepEqual(f.files.get(file),bytes);assert.deepEqual(credentials(f.calls),[]);
});

test('新Chrome账号未确认时不生成登录时间，不读取导出Cookie或内部备份',async()=>{
  const f=fixture([{id:'new',platform:'YouTube',name:'Chrome备注',status:'未登录',lastSync:null}]);
  await f.manager.openExternalLogin('new');const result=await f.manager.complete('new');
  assert.equal(result.saved,true);assert.equal(result.verified,false);assert.match(result.message,/尚待确认|尚待.*验证/);
  const a=f.account('new');assert.equal(a.lastSync,null);assert.equal(a.lastVerified,undefined);assert.doesNotMatch(a.status,/已确认|登录成功/);
  assert.deepEqual(credentials(f.calls),[]);assert.equal(await f.manager.cookieFile('YouTube','new'),null);
});

test('已确认Chrome登录仅保存绑定元数据，不覆盖原内部会话备份或导出浏览器凭据',async()=>{
  const f=fixture([oldAccount()]),file=f.manager.backupFile('old');f.files.set(file,Buffer.from('synthetic-internal-backup'));const before=Buffer.from(f.files.get(file));
  f.browser.loginState={authenticated:true};await f.manager.openExternalLogin('old');const result=await f.manager.complete('old');await f.manager.persist('old');await f.manager.flushAll();
  assert.equal(result.saved,true);assert.equal(result.verified,true);assert.equal(f.account('old').loginBackend,'external-chrome');assert.equal(f.manager.usesExternal('小红书','old'),true);assert.ok(f.account('old').lastSync>100);
  assert.deepEqual(f.files.get(file),before);assert.deepEqual(credentials(f.calls),[]);assert.equal(await f.manager.cookieFile('小红书','old'),null);
  assert.ok(f.calls.filter(([kind])=>kind==='chrome-evaluate').every(([,expression])=>!/(?:document\.cookie|localStorage|sessionStorage|Storage\.getCookies|Network\.getCookies)/.test(expression)));
});

test('退出Chrome绑定只关闭自己的标签，不清浏览器登录或旧内部备份及其他账号标签',async()=>{
  const f=fixture([{...oldAccount('抖音','one'),loginBackend:'external-chrome'},{...oldAccount('YouTube','two'),loginBackend:'external-chrome'}]);
  for(const id of ['one','two'])await f.manager.openExternalLogin(id);
  const file=f.manager.backupFile('one');f.files.set(file,Buffer.from('synthetic-keep-internal'));await f.manager.logout('one');
  assert.equal(f.tabs[0].closed,true);assert.equal(f.tabs[1].closed,false);assert.equal(f.account('one').lastSync,null);assert.equal(f.account('two').status,'登录中');assert.match(f.account('one').message,/浏览器.*登录.*保留/);
  assert.equal(f.files.get(file).toString(),'synthetic-keep-internal');assert.deepEqual(credentials(f.calls),[]);
});

test('明确使用内置兼容登录后完成流程不能被旧Chrome标记抢回',async()=>{
  const f=fixture([{...oldAccount('YouTube','switch'),loginBackend:'external-chrome'}]);
  f.sessionFor('switch').cookies.values.push({domain:'.youtube.com',name:'fixture',value:'synthetic-internal',path:'/',secure:true});
  await f.manager.login('switch');assert.equal(f.account('switch').loginBackend,'embedded');
  const before=f.calls.filter(([kind])=>kind==='chrome-evaluate').length;const result=await f.manager.complete('switch');assert.equal(result.saved,true);assert.equal(f.calls.filter(([kind])=>kind==='chrome-evaluate').length,before,'兼容完成不能再次读取Chrome');
});

test('Chrome账号备注共享当前浏览器profile，不能虚假承诺按备注隔离登录身份',async()=>{
  const f=fixture([{id:'one',name:'备注一',platform:'YouTube',status:'未登录'},{id:'two',name:'备注二',platform:'YouTube',status:'未登录'}]);
  const results=[];for(const id of ['one','two'])results.push(await f.manager.openExternalLogin(id));
  const opens=f.calls.filter(([kind])=>kind==='chrome-open');assert.equal(opens.length,2);assert.deepEqual(opens[0][2],opens[1][2],'同一受控Chrome没有为备注创建独立profile或复制Cookie');
  const ui=fs.readFileSync(new URL('../src/ExternalBrowserLogin.jsx',import.meta.url),'utf8');
  assert.match([...results.map(r=>r.message),ui].join(' '),/多个.{0,15}(?:共享|共用)|(?:共享|共用).{0,15}Chrome|账号备注.{0,15}不.{0,10}隔离/,'须向用户说明多个备注并不隔离Chrome登录身份');
});

test('仅新或未保存的pending Chrome账号可先采集公开网页，旧正常账号保持原路由',async()=>{
  const f=fixture([oldAccount('抖音','old'),{id:'new',name:'新账号',platform:'YouTube',lastSync:null,status:'未登录'}]);
  await f.manager.openExternalLogin('old');await f.manager.openExternalLogin('new');
  assert.equal(f.manager.usesExternal('抖音','old'),false);assert.equal(f.manager.usesExternal('YouTube','new'),true);
  assert.equal(f.account('new').lastSync,null);assert.equal(f.account('new').lastVerified,undefined);
  assert.deepEqual(credentials(f.calls),[]);
});

test('旧B站内部下载Cookie在Chrome确认及重启后继续可用，没有拷贝Chrome凭据',async()=>{
  const f=fixture([oldAccount('B站','bili')]);
  const original={domain:'.bilibili.com',path:'/',name:'SESSDATA',value:'synthetic-original-bili',secure:true};
  f.sessionFor('bili').cookies.values.push(original);const backup=f.manager.backupFile('bili');f.files.set(backup,Buffer.from(JSON.stringify([original])));
  f.browser.loginState={authenticated:true};await f.manager.openExternalLogin('bili');await f.manager.complete('bili');
  assert.deepEqual(credentials(f.calls),[],'确认Chrome不读取内置或Chrome凭据');assert.equal(f.account('bili').internalSession.lastSync,100);
  const downloadFile=await f.manager.cookieFile('B站','bili');assert.ok(downloadFile);assert.match(f.files.get(downloadFile).toString(),/synthetic-original-bili/,'只延续原已存在内部下载Cookie');
  const restarted=fixture([f.account('bili')]);restarted.files.set(backup,Buffer.from(f.files.get(backup)));await restarted.manager.restore();
  assert.equal(restarted.account('bili').loginBackend,'external-chrome');assert.equal(restarted.account('bili').status,'Chrome 登录已确认');
  assert.equal(restarted.sessionFor('bili').cookies.values.find(c=>c.name==='SESSDATA').value,'synthetic-original-bili');assert.equal(restarted.calls.some(([kind])=>kind==='chrome-open'),false,'恢复内部备份不能自动打开或验证Chrome');
});

test('旧内部备份过期仅标记内部下载用途，不能误标已确认的Chrome网页登录',async()=>{
  const a={...oldAccount('B站','bili'),loginBackend:'external-chrome',status:'Chrome 登录已确认',lastSync:400,lastVerified:500,internalSession:{lastSync:100,lastVerified:200,status:'会话已保存'}};
  const f=fixture([a]);f.files.set(f.manager.backupFile('bili'),Buffer.from(JSON.stringify([{domain:'.bilibili.com',path:'/',name:'SESSDATA',value:'synthetic-expired-internal',expirationDate:1}])));
  await f.manager.restore();assert.equal(f.account('bili').status,'Chrome 登录已确认');assert.equal(f.account('bili').lastSync,400);assert.equal(f.account('bili').lastVerified,500);assert.equal(f.account('bili').internalSession.lastSync,null);assert.equal(await f.manager.cookieFile('B站','bili'),null);
});

test('Chrome重新验证失败不沿用旧Chrome成功时间，退出后可恢复原正常内置用途',async()=>{
  const a={...oldAccount('小红书','xhs'),loginBackend:'external-chrome',status:'Chrome 登录已确认',lastSync:400,lastVerified:500,internalSession:{lastSync:100,lastVerified:200,status:'会话已保存'}};
  const f=fixture([a]);f.browser.loginState={authenticated:false,message:'当前Chrome需要重新登录'};
  await f.manager.openExternalLogin('xhs');const result=await f.manager.complete('xhs');assert.equal(result.verified,false);assert.equal(f.account('xhs').lastSync,null);assert.equal(f.account('xhs').lastVerified,null);
  await f.manager.logout('xhs');assert.equal(f.account('xhs').loginBackend,'embedded');assert.equal(f.account('xhs').lastSync,100);assert.equal(f.account('xhs').lastVerified,200);assert.equal(f.manager.usesExternal('小红书','xhs'),false);assert.deepEqual(credentials(f.calls),[]);
});

test('已确认Chrome B站门禁以官方nav isLogin为准，不读取内置Cookie或以头像代替',async()=>{
  const f=fixture([{...oldAccount('B站','bili'),loginBackend:'external-chrome'}]);
  assert.equal(await f.manager.bilibiliLoginReady('bili'),true);f.browser.apiResponse={status:200,ok:true,text:'{"code":0,"data":{"isLogin":false}}'};assert.equal(await f.manager.bilibiliLoginReady('bili'),false);
  f.browser.apiResponse={status:403,ok:false,text:'{}'};assert.equal(await f.manager.bilibiliLoginReady('bili'),false);assert.deepEqual(credentials(f.calls),[]);assert.ok(f.tabs.every(tab=>tab.closed));
  assert.ok(f.calls.filter(([kind])=>kind==='chrome-evaluate').every(([,expression])=>!/(?:document\.cookie|localStorage|sessionStorage|getAllCookies)/.test(expression)));
});

test('取消Chrome接口仅读取自己的专用背景标签，登录标签及其他标签保留',async()=>{
  const f=fixture([{...oldAccount('B站','bili'),loginBackend:'external-chrome'}]);await f.manager.openExternalLogin('bili');const login=f.tabs[0];f.browser.holdApi=true;const controller=new AbortController();
  const pending=f.manager.fetch('bili','https://api.bilibili.com/x/web-interface/nav',{signal:controller.signal});
  while(!f.browser.releaseApi)await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending);assert.equal(login.closed,false);assert.equal(f.tabs[1].closed,true);f.browser.releaseApi();assert.deepEqual(credentials(f.calls),[]);
});

test('未确认Chrome绑定拒绝官方API请求，原native fetch路径保持原样',async()=>{
  const f=fixture([{...oldAccount('B站','bili'),loginBackend:'external-chrome',lastSync:null},oldAccount('视频号','native')]);
  await assert.rejects(f.manager.fetch('bili','https://api.bilibili.com/x/web-interface/nav'),/尚未确认/);assert.equal(f.tabs.length,0);
  const options={method:'POST',body:'fixture'};const response=await f.manager.fetch('native','https://yuanbao.tencent.com/api/weixin/get_parse_result',options);assert.equal(response.ok,true);assert.equal(f.calls.find(([kind])=>kind==='native-fetch')[2],options);
});

test('显式导入已有会话文件切回内置完成路径，不忽略所选文件而跑Chrome检测',async()=>{
  const f=fixture([{...oldAccount('YouTube','import'),loginBackend:'external-chrome'}]);
  f.files.set('selected-cookies.txt',Buffer.from('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tfixture\tsynthetic-imported\n'));
  await f.manager.importCookies('import','selected-cookies.txt');assert.equal(f.account('import').loginBackend,'embedded');assert.equal(f.account('import').pendingLoginBackend,undefined);assert.ok(f.account('import').lastSync>0);assert.equal(f.tabs.length,0);assert.equal(f.sessionFor('import').cookies.values[0].value,'synthetic-imported');
});

test('B站完成Chrome登录必须取当前工具标签的nav结果，头像或旧验证时间不足以确认',async()=>{
  const f=fixture([oldAccount('B站','bili')]);f.browser.loginState={authenticated:true};f.browser.apiResponse={status:200,ok:true,text:'{"code":0,"data":{"isLogin":false}}'};
  await f.manager.openExternalLogin('bili');f.manager.fetch=()=>{throw Error('尚未确认时不能使用受保护accounts.fetch');};
  let result=await f.manager.complete('bili');assert.equal(result.verified,false,'头像占位不能冒充B站nav登录确认');assert.equal(f.account('bili').loginBackend,undefined);assert.equal(f.account('bili').lastVerified,200);assert.equal(f.tabs.length,1,'应检测原来的本工具登录标签');
  f.browser.loginState={authenticated:false};f.browser.apiResponse={status:200,ok:true,text:'{"code":0,"data":{"isLogin":true}}'};
  result=await f.manager.complete('bili');assert.equal(result.verified,true,'官网nav确认比DOM占位可靠');assert.equal(f.account('bili').loginBackend,'external-chrome');assert.equal(f.tabs.length,1);assert.equal(f.tabs[0].closed,false,'检测不能关闭正在使用的登录标签');assert.deepEqual(credentials(f.calls),[]);
});

test('生产preferExternalBrowsing只改变网页路由，不迁移旧账号或改变内部下载会话',async()=>{
  const f=fixture([oldAccount('B站','bili'),oldAccount('小红书','xhs'),oldAccount('视频号','wechat')],{preferExternalBrowsing:true});
  const before=['bili','xhs','wechat'].map(f.account);const backup=f.manager.backupFile('bili');f.files.set(backup,Buffer.from('synthetic-original-backup'));
  assert.equal(f.manager.usesExternal('B站','bili'),true);assert.equal(f.manager.usesExternal('小红书','xhs'),true);assert.equal(f.manager.usesExternal('视频号','wechat'),false,'电脑微信视频号仍独立连接');assert.deepEqual(['bili','xhs','wechat'].map(f.account),before);assert.equal(f.tabs.length,0,'路由选择本身不能启动或切换登录');
  f.sessionFor('bili').cookies.values.push({domain:'.bilibili.com',path:'/',name:'SESSDATA',value:'synthetic-native-download',secure:true});const download=await f.manager.cookieFile('B站','bili');assert.match(f.files.get(download).toString(),/synthetic-native-download/);assert.equal(f.files.get(backup).toString(),'synthetic-original-backup');
  await f.manager.fetch('bili','https://api.bilibili.com/x/web-interface/nav');assert.equal(f.calls.at(-1)[0],'native-fetch','网页优先Chrome不能偷偷改变旧B站官方API/下载会话');assert.deepEqual(['bili','xhs','wechat'].map(f.account),before);
});
