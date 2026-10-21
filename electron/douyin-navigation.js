import {setTimeout as delay} from 'node:timers/promises';

// These two functions are serialized into the app-owned official Chrome tab.
// They inspect public UI only; no storage, private endpoints or page internals.
export function douyinVisibleState(){
  const u=new URL(location.href),official=u.protocol==='https:'&&u.hostname==='www.douyin.com'&&!u.username&&!u.password&&!u.port;
  if(!official)return {official:false};
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';
  const input=[...document.querySelectorAll('input[data-e2e="searchbar-input"]')].find(visible);
  const button=[...document.querySelectorAll('button[data-e2e="searchbar-button"]')].find(visible);
  const active=[...document.querySelectorAll('[data-e2e="feed-active-video"]')].find(visible);
  let searchKeyword=null;try{searchKeyword=decodeURIComponent(u.pathname.match(/^\/(?:jingxuan\/)?search\/(.+?)\/?$/)?.[1]||'')||null;}catch{}
  const verification=/验证码中间页|安全验证/.test(document.title)||[...document.querySelectorAll('[class*="captcha"],[id*="captcha"],iframe[src*="captcha"]')].some(visible);
  const login=[...document.querySelectorAll('[data-e2e="login-dialog"],.login-modal')].some(visible);
  const serviceError=[...document.querySelectorAll('div,p,h1,h2,h3,span,[role="alert"]')].some(e=>visible(e)&&/^(?:网络出现问题|请检查网络连接后重试|服务器出现问题|服务器开小差了|服务暂时不可用|网络开小差了)[。！!]?$/u.test(e.innerText?.trim()||''));
  const message=verification?'请在抖音官方窗口完成安全验证，然后继续。':login?'请在抖音官方窗口完成登录，然后继续。':serviceError?'抖音官网当前显示网络或服务异常，已有结果保留，请在网络恢复后继续。':undefined;
  return {official,path:u.pathname,ready:document.readyState,searchReady:!!input&&!!button,searchValue:input?.value,searchKeyword,searchType:u.searchParams.get('type'),modalId:u.searchParams.get('modal_id'),activeId:active?.getAttribute('data-e2e-vid')||null,
    blocked:verification||login||serviceError,message,...(message?{action:{kind:verification?'verification':login?'login':'network',message,retryable:!!serviceError}}:{})};
}
export function douyinVisibleAction(action,payload){
  const page=new URL(location.href);
  if(page.protocol!=='https:'||page.hostname!=='www.douyin.com'||page.username||page.password||page.port)return {found:false,reason:'outside'};
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
  let element;
  if(action==='focus'){
    element=[...document.querySelectorAll('input[data-e2e="searchbar-input"]')].find(visible);
    if(element){element.focus();element.select();return {found:true};}
  }else if(action==='search')element=[...document.querySelectorAll('button[data-e2e="searchbar-button"]')].find(visible);
  else if(action==='work'){
    if(!/^\/(?:jingxuan\/search\/|search\/|user\/)/.test(location.pathname))return {found:false,reason:'outside-list'};
    const safe=e=>visible(e)&&!e.closest('[data-e2e="comment-list"],[data-e2e="comment-item"],nav,header,aside');
    const id=String(payload.id),links=[...document.querySelectorAll('a[href]')].filter(e=>{
      if(!safe(e))return false;
      try{const u=new URL(e.href,location.href);return u.protocol==='https:'&&u.hostname==='www.douyin.com'&&!u.username&&!u.password&&!u.port&&(u.pathname.match(/^\/(?:video|note)\/(\d+)\/?$/)?.[1]===id||u.searchParams.get('modal_id')===id);}catch{return false;}
    });
    // Several cover/title anchors for the same exact ID are equivalent. Never
    // choose an unrelated first card when a modern card exposes no href.
    if(links.length)element=links[0];
    else{
      const title=norm(payload.title),titles=[...document.querySelectorAll('div,h3,[data-e2e="video-desc"]')].filter(e=>safe(e)&&e.children.length===0&&norm(e.innerText)===title);
      if(titles.length!==1)return {found:false,reason:titles.length?'ambiguous':'missing'};
      element=titles[0];
    }
  }
  if(!element)return {found:false,reason:'missing'};
  element.scrollIntoView({block:'center',inline:'center'});
  const r=element.getBoundingClientRect();
  return {found:true,x:r.left+r.width/2,y:r.top+r.height/2};
}
export const douyinWorkIdentity=(state,id)=>!!state?.official&&state.modalId===String(id)&&state.activeId===String(id);
const evaluate=(w,fn,...args)=>w.webContents.executeJavaScript(`(${fn.toString()})(${args.map(v=>JSON.stringify(v)).join(',')})`);
function requireTab(w,signal){signal?.throwIfAborted();if(!w?.externalTab)throw Error('此流程需要本工具创建的外置 Chrome 页面');if(w.isDestroyed())throw Error('抖音官方窗口已关闭，请重新搜索');}
function pause(w,message,action={kind:'page',message,retryable:false}){w.show();return Object.assign(Error(message),{needsAction:true,keepWindow:true,action,code:action.kind==='login'?'OFFICIAL_LOGIN_REQUIRED':action.kind==='verification'?'OFFICIAL_VERIFICATION_REQUIRED':action.kind==='network'?'OFFICIAL_SERVICE_UNAVAILABLE':'OFFICIAL_PAGE_NOT_READY'});}
async function state(w,signal,{allowService=false}={}){requireTab(w,signal);const s=await evaluate(w,douyinVisibleState);signal?.throwIfAborted();if(s.blocked&&!(allowService&&s.action?.kind==='network'))throw pause(w,s.message,s.action);return s;}
async function click(w,point,signal){
  requireTab(w,signal);
  if(!point?.found||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw pause(w,'尚未找到可操作的官方控件，请检查官方窗口后继续。');
  for(const type of ['mousePressed','mouseReleased'])await w.externalTab.send('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1});
}
const sameSearch=(s,keyword)=>s.official&&s.searchKeyword===keyword&&[null,'general','video'].includes(s.searchType)&&!s.modalId;

export async function openDouyinSearch(w,keyword,signal,{restart=false,navigate=url=>w.loadURL(url),wait=delay,maxPolls=20}={}){
  requireTab(w,signal);keyword=String(keyword||'').trim();if(!keyword)throw Error('请输入抖音搜索关键词');
  // A newly created CDP tab is about:blank. Its official-page guard correctly
  // refuses script reads there, so navigate before the first DOM probe.
  const current=w.webContents.getURL?.()||w.externalTab.url;
  let navigated=false;
  if(current==='about:blank'||/^chrome-error:\/\/chromewebdata\//.test(current||'')){await navigate('https://www.douyin.com/');navigated=true;}
  let s=await state(w,signal,{allowService:restart});
  if(!restart&&sameSearch(s,keyword))return w;
  // The official homepage initializes routing/context before its search UI is
  // usable. Deep links were observed failing on the same authorized browser.
  if(!navigated&&(restart||!s.official||!/^\/(?:jingxuan)?\/?$/.test(s.path)))await navigate('https://www.douyin.com/');
  let previousPath,stable=0,ready=false;
  for(let i=0;i<maxPolls;i++){
    s=await state(w,signal);
    stable=s.official&&s.ready==='complete'&&s.searchReady&&s.path===previousPath?stable+1:0;previousPath=s.path;
    if(stable>=4){ready=true;break;}
    await wait(1000,undefined,{signal});
  }
  if(!ready)throw pause(w,'抖音首页尚未完成加载，请在官方窗口确认网络或验证后继续。');
  const focused=await evaluate(w,douyinVisibleAction,'focus',{});
  if(!focused?.found)throw pause(w,'抖音首页尚未显示搜索框，请检查官方窗口后继续。');
  await w.externalTab.send('Input.insertText',{text:keyword});
  s=await state(w,signal);
  if(s.searchValue!==keyword)throw pause(w,'官方搜索框未保留本次关键词，请检查页面后继续。');
  await click(w,await evaluate(w,douyinVisibleAction,'search',{}),signal);
  for(let i=0;i<maxPolls;i++){
    s=await state(w,signal);if(sameSearch(s,keyword))return w;
    await wait(1000,undefined,{signal});
  }
  throw pause(w,'抖音尚未进入本次关键词的搜索结果，请在官方窗口检查后继续。');
}
export async function selectDouyinWork(w,item,signal,{wait=delay,maxPolls=12}={}){
  requireTab(w,signal);
  let u;try{u=new URL(item?.url);}catch{}
  const id=String(item?.id||'');
  if(item?.platform!=='抖音'||!/^\d{5,30}$/.test(id)||!item.title||u?.protocol!=='https:'||u.hostname!=='www.douyin.com'||u.username||u.password||u.port||u.pathname.match(/^\/(?:video|note)\/(\d+)\/?$/)?.[1]!==id)throw Error('无法确认选中抖音作品的身份');
  let s=await state(w,signal);
  if(douyinWorkIdentity(s,id))return w;
  if(s.modalId)throw pause(w,'官方窗口当前打开了其他作品，请返回包含目标作品的结果列表后继续。');
  const target=await evaluate(w,douyinVisibleAction,'work',{id,title:item.title});
  if(!target?.found)throw pause(w,target?.reason==='ambiguous'?'官方页面有多个同名作品，无法确认目标，请在官方页面打开准确作品后继续。':'当前官方结果列表未显示该准确作品，请返回原搜索或博主页面并显示该作品后继续。');
  await click(w,target,signal);
  for(let i=0;i<maxPolls;i++){
    s=await state(w,signal);
    if(douyinWorkIdentity(s,id))return w;
    if(s.modalId&&s.modalId!==id||s.modalId===id&&s.activeId&&s.activeId!==id)throw pause(w,'打开作品与选中作品身份不一致，已暂停，未读取其他作品评论。');
    await wait(500,undefined,{signal});
  }
  throw pause(w,'尚未同时确认作品地址与当前播放作品，请在官方页面打开准确作品后继续。');
}
