import { BrowserWindow } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { contentItem, xhsContent, douyinContent, mergeContent } from './content-data.js';
import { officialUserAgent } from './account-session.js';
import {contentLoadMessage,contentLoadError,contentAction} from './content-network.js';
import {contentNavigation} from './content-navigation.js';
import {navigateOfficialPage,transientNavigationError} from './browser-navigation.js';
import {douyinPageState} from './douyin-page.js';
import {externalBrowserWindow} from './external-browser-window.js';
import {openDouyinSearch,douyinVisibleState,selectDouyinWork as selectVisibleDouyinWork} from './douyin-navigation.js';
export function contentSearchURL(platform, keyword,options={}) {
  const q = encodeURIComponent(keyword),today=new Date(),month=new Date(today.getFullYear(),today.getMonth()-1,Math.min(today.getDate(),new Date(today.getFullYear(),today.getMonth(),0).getDate())),year=new Date(today.getFullYear()-1,today.getMonth(),today.getDate());
  const from=options.from?new Date(options.from+'T00:00:00'):month,filter=from>=month?'CAISAggE':from>=year?'CAISAggF':'EgIQAfABAQ%253D%253D';
  return { '小红书':`https://www.xiaohongshu.com/search_result/?keyword=${q}&source=web_explore_feed&type=0`, '抖音':`https://www.douyin.com/jingxuan/search/${q}?type=general`, YouTube:`https://www.youtube.com/results?search_query=${q}&sp=${filter}` }[platform];
}
// Only fields needed for the selected work are returned; tokens and storage stay in the official session.
export function renderedContent(platform, keyword, detail = false) {
  const here = new URL(location.href), visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const body = document.body?.innerText || '';
  const blocked=(kind,message,reason=kind)=>({blocked:true,reason,message,action:{kind,message,retryable:false},items:[]});
  const deviceLimit=[...document.querySelectorAll('.login-modal,[class*="login-container"]')].some(e=>visible(e)&&/设备登录超限/.test(e.innerText||''));
  if(deviceLimit)return blocked('login','小红书提示电脑设备登录超限，当前会话已被平台拒绝，请在官方窗口重新登录；已有结果保留。','device-limit');
  const verification = /unusual traffic|安全限制|安全验证|验证码中间页/i.test(document.title) || [...document.querySelectorAll('[class*="captcha"],iframe[src*="captcha"]')].some(visible);
  if (verification) return blocked('verification','请在官方窗口完成安全验证，已有结果保留。');
  if([...document.querySelectorAll('.login-modal,[data-e2e="login-dialog"]')].some(visible))return blocked('login','请在本工具的官方窗口完成登录，已有结果保留。');
  if (detail) {
    if(platform==='YouTube'){
      const player=window.ytInitialPlayerResponse,info=player?.microformat?.playerMicroformatRenderer;
      if(player?.videoDetails?.videoId===here.searchParams.get('v')&&info)return {detail:{id:player.videoDetails.videoId,publishedAt:info.publishDate||info.uploadDate||null},items:[]};
      return {items:[]};
    }
    if (platform === '小红书') {
      if(/页面不见了|笔记不存在|笔记已删除|内容不存在/.test(document.title+' '+body))return {unavailable:true,message:'该笔记已失效或不可访问，其他作品可以继续读取'};
      const state = window.__INITIAL_STATE__?.note?.noteDetailMap;
      const id = here.pathname.match(/\/(?:explore|discovery\/item)\/([a-f\d]{24})/i)?.[1];
      const note = state && Object.values(state).find(v => String(v.note?.noteId || v.note?.note_id || '') === id)?.note;
      if (note) return {note:{id,note_card:{...note, image_list:note.imageList, time:note.time, user:{nickname:note.user?.nickname}},xsec_token:here.searchParams.get('xsec_token')}};
      const root = document.querySelector('.note-container');
      return {detail:{id,url:here.href,title:root?.querySelector('#detail-title,.title')?.textContent || '',text:root?.querySelector('#detail-desc,.desc')?.innerText || '',images:[...root?.querySelectorAll('.swiper-slide img') || []].map(i=>i.src),type:root?.querySelector('video')?'video':'image',bodyComplete:!!root?.querySelector('#detail-desc,.desc')},items:[]};
    }
    return {items:[]};
  }
  let douyinSearch=false;
  if(platform==='抖音'&&here.hostname==='www.douyin.com')try{
    const path=decodeURIComponent(here.pathname).replace(/\/+$/,''),type=here.searchParams.get('type');
    douyinSearch=path===`/search/${keyword}`&&type==='video'||path===`/jingxuan/search/${keyword}`&&(type===null||type==='general'||type==='video');
  }catch{ /* A malformed address is outside this search, not a script failure. */ }
  const validPage = platform === 'YouTube' ? here.hostname === 'www.youtube.com' && here.pathname === '/results' && here.searchParams.get('search_query') === keyword
    : platform === '小红书' ? ['www.xiaohongshu.com','xiaohongshu.com'].includes(here.hostname) && here.pathname.replace(/\/+$/,'') === '/search_result' && here.searchParams.get('keyword') === keyword
    : douyinSearch;
  if (!validPage) return blocked('page','官方窗口已离开本次作品搜索，请重新搜索。');
  const items=[];
  const dateText = text => {
    if(/编辑|更新|修改/.test(text))return null;
    const full = text.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if(full) return `${full[1]}-${full[2].padStart(2,'0')}-${full[3].padStart(2,'0')}`;
    const d=new Date();const short=text.trim().match(/^(\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+\d{1,2}:\d{2})?$/);
    if(short){let year=d.getFullYear();const month=Number(short[1]),day=Number(short[2]);if(month>d.getMonth()+1||month===d.getMonth()+1&&day>d.getDate())year--;const date=new Date(year,month-1,day);if(date.getMonth()!==month-1||date.getDate()!==day)return null;return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;}
    if(/^(今天|昨天|刚刚)(?:\s|$)/.test(text.trim())){if(text.trim().startsWith('昨天'))d.setDate(d.getDate()-1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
    const m=text.match(/(\d+)\s*(天|日|小时|分钟|days?|hours?|minutes?)\s*(前|ago)/i);
    if(m) {d.setTime(d.getTime()-Number(m[1])*(/天|日|days?/i.test(m[2])?86400000:/小时|hours?/i.test(m[2])?3600000:60000));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
    return null; // IDs, modification dates and vague month labels are not publication dates.
  };
  const selector=platform==='YouTube'?'ytd-video-renderer':platform==='小红书'?'.feeds-container .note-item,section.note-item':'[data-e2e="search-video-list"] li,[data-e2e="search-video-item"]';
  for(const card of document.querySelectorAll(selector)) {
    if(!visible(card))continue;
    const links=[...card.querySelectorAll('a[href]')].filter(a=>{try{const u=new URL(a.href);return u.origin===here.origin && (platform==='YouTube'?u.pathname==='/watch'&&u.searchParams.has('v'):platform==='小红书'?/^\/(?:explore|discovery\/item|search_result)\/[a-f\d]{24}\/?$/i.test(u.pathname):/\/video\/\d+/.test(u.pathname));}catch{return false;}});
    const a=platform==='小红书'?links.find(a=>new URL(a.href).searchParams.has('xsec_token'))||links[0]:links[0];
    if(!a)continue;const u=new URL(a.href),id=platform==='YouTube'?u.searchParams.get('v'):u.pathname.match(platform==='小红书'?/\/(?:explore|discovery\/item|search_result)\/([a-f\d]{24})/i:/\/video\/(\d+)/)?.[1];
    if(platform==='小红书'&&u.pathname.startsWith('/search_result/'))u.pathname='/explore/'+id;
    const label=card.querySelector('#metadata-line,.time,.date')?.innerText||'';
    items.push({id,url:u.href,title:card.querySelector('#video-title,.title,[data-e2e="video-desc"]')?.textContent || a.title || '',author:card.querySelector('#channel-name,.author .name,[data-e2e="video-author"]')?.textContent || '',thumbnail:card.querySelector('img')?.src || '',publishedAt:dateText(label),publishedAtSource:/\b20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(label)?'exact':'estimated',type:platform==='小红书'&&!card.querySelector('.play-icon,.video-icon,[class*="video"],use[href*="video"],use[xlink\\:href*="video"]')?'image':'video'});
  }
  const loggedIn=platform==='小红书'&&[...document.querySelectorAll('.side-bar a[href*="/user/profile/"],nav a[href*="/user/profile/"],aside a[href*="/user/profile/"]')].some(e=>visible(e)&&e.innerText.trim()==='我');
  // Only a visible list-end indicator outside work cards can finish pagination.
  const complete=[...document.querySelectorAll('.feeds-container .end-container,.feeds-container .no-more,.feeds-container .no-more-text,[data-e2e="search-video-list"] .no-more,[data-e2e="search-list-end"],ytd-search .no-more')].some(e=>visible(e)&&!e.closest?.('.note-item,[data-e2e="search-video-item"],li,ytd-video-renderer')&&/^(没有更多了|没有更多作品|没有更多笔记|暂无更多)([。！!…\s]*)$/.test(e.innerText?.trim()||''));
  return {items,loggedIn,empty:/没有搜索结果|没有找到相关笔记|No results found/.test(body)&&!items.length,complete};
}
export class ContentBrowser {
  constructor(accounts){this.accounts=accounts;this.window=null;this.items=new Map();this.openGeneration=0;}
  close(){this.openGeneration++;if(this.window&&!this.window.isDestroyed())this.window.destroy();this.window=null;this.pendingDouyinSearch=false;}
  pause(){this.onProgress=null;if(this.window&&!this.window.isDestroyed())this.window.hide();}
  show(){if(this.window&&!this.window.isDestroyed()){this.window.show();this.window.focus();}}
  async checkAction(record,signal){
    signal?.throwIfAborted();const w=this.window;
    const detail=this.scope?.detailId&&this.scope.platform===record.platform&&this.scope.accountId===record.accountId;
    if(!w||w.isDestroyed()||this.recordId!==record.id&&!detail){const message='本次官方窗口已关闭，请打开官方窗口后继续。';return {ready:false,closed:true,message,action:contentAction('page',message)};}
    try{
      if(record.platform==='抖音'&&w.externalTab){
        const s=await w.webContents.executeJavaScript(`(${douyinVisibleState.toString()})()`);signal?.throwIfAborted();
        if(w!==this.window||w.isDestroyed())return {ready:false,closed:true,message:'官方窗口已关闭。',action:contentAction('page','请重新打开官方窗口。')};
        if(s.blocked)return {ready:false,message:s.message,action:s.action||contentAction('page',s.message)};
        const same=s.official&&s.searchKeyword===record.keyword&&[null,'general','video'].includes(s.searchType)&&!s.modalId;
        if(s.ready!=='loading'&&this.pendingDouyinSearch&&s.official&&s.searchReady&&!s.modalId)return {ready:true,message:'官方页面已就绪，可以继续本次搜索。'};
        if(s.ready!=='loading'&&same){
          const rendered=await w.webContents.executeJavaScript(`(${renderedContent.toString()})('抖音',${JSON.stringify(record.keyword)})`);signal?.throwIfAborted();
          if(rendered.blocked)return {ready:false,message:rendered.message,action:rendered.action||contentAction(rendered.reason,rendered.message)};
          if(rendered.items?.length||rendered.empty||rendered.complete)return {ready:true,message:'官方搜索结果已恢复，可以继续读取。'};
        }
        const message='请在本次官方搜索窗口完成页面加载；不要切换到其他作品。';return {ready:false,message,action:contentAction('page',message)};
      }
      const snapshot=await w.webContents.executeJavaScript(`(${renderedContent.toString()})(${JSON.stringify(record.platform)},${JSON.stringify(record.keyword)},${!!detail})`);signal?.throwIfAborted();
      if(snapshot.blocked)return {ready:false,message:snapshot.message,action:snapshot.action||contentAction(snapshot.reason,snapshot.message)};
      if(detail&&snapshot.detail?.id!==this.scope.detailId&&snapshot.note?.id!==this.scope.detailId){const message='原作品详情尚未确认，请在当前官方窗口完成登录或页面加载。';return {ready:false,message,action:contentAction('page',message)};}
      if(!detail&&!snapshot.items?.length&&!snapshot.empty&&!snapshot.complete){const message='官方页面尚未返回可读取的作品，正在等待页面加载。';return {ready:false,message,action:contentAction('page',message)};}
      return {ready:true,message:'官方页面已就绪，可以继续本次搜索。'};
    }catch(error){if(signal?.aborted)throw error;const failure=contentLoadError(error);return {ready:false,message:failure.message,action:failure.action,code:failure.code};}
  }
  async openAction(record,signal){
    const activeSignal=signal||new AbortController().signal;activeSignal.throwIfAborted();
    const detail=this.scope?.detailId&&this.scope.platform===record.platform&&this.scope.accountId===record.accountId;
    if(!this.window||this.window.isDestroyed()||this.recordId!==record.id&&!detail){
      try{await this.open(detail?this.sourceURL:contentSearchURL(record.platform,record.keyword,record.options),detail?this.scope:record,activeSignal,{early:true});}
      catch(error){if(activeSignal.aborted)throw error;const failure=contentLoadError(error);return {ready:false,message:failure.message,action:failure.action,code:failure.code,closed:!this.window||this.window.isDestroyed()};}
    }
    this.show();return this.checkAction(record,activeSignal);
  }
  async open(url,record,signal,options={}){
    try{return await this.openPage(url,record,signal,options);}
    catch(error){
      if(signal.aborted)throw new Error('已停止搜索');
      const failure=contentLoadError(error);
      // Navigation has its own single retry. This path covers connection loss
      // while creating/attaching a new tab, before navigation begins.
      if(options.autoRetry!==false&&!failure.recoveryAttempts&&transientNavigationError(failure)&&(!this.window||this.window.isDestroyed())){
        this.close();await delay(350,undefined,{signal});
        try{const window=await this.openPage(url,record,signal,{...options,reuse:false,autoRetry:false});this.autoRecoveryUsed=true;return window;}
        catch(next){if(signal.aborted)throw new Error('已停止搜索');const failed=contentLoadError(next);failed.recoveryAttempts=1;throw failed;}
      }
      throw failure;
    }
  }
  async openPage(url, record, signal, {reuse=false,early=false,autoRetry=true}={}) {
    signal.throwIfAborted();
    const previous=reuse&&this.window&&!this.window.isDestroyed()&&this.accountId===record.accountId?this.window:null;
    if(!previous)this.close();const generation=++this.openGeneration;this.items=new Map();this.recordId=record.id;this.sourceURL=url;this.complete=false;this.networkError=null;this.networkAction=null;this.autoRecoveryUsed=false;this.networkSignal=signal;this.scope=record;this.accountId=record.accountId;this.scrollSteps=0;
    const s=record.accountId?this.accounts.getSession(record.accountId):undefined;
    const w=previous||(this.accounts.usesExternal?.(record.platform,record.accountId)?await externalBrowserWindow(this.accounts.externalBrowser,url,record.platform,{session:s,signal}):new BrowserWindow({show:!this.hidden,width:1100,height:800,autoHideMenuBar:true,title:'作品搜索 · 完成官方登录或验证后继续',webPreferences:{session:s,partition:s?undefined:`fengsha-content-${record.platform}`,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'document-user-activation-required'}}));
    if(signal.aborted||generation!==this.openGeneration){if(!previous&&!w.isDestroyed())w.destroy();signal.throwIfAborted();throw Error('已停止过期的官方页面准备');}this.window=w;
    w.setMenu(null);w.webContents.setAudioMuted(true);w.webContents.setWindowOpenHandler(({url:target})=>{if(record.platform==='YouTube'&&contentNavigation(target,url,record.platform).authentication)void w.loadURL(target,{userAgent:officialUserAgent}).catch(()=>{});return {action:'deny'};});
    const allowed=value=>contentNavigation(value,url,record.platform).allowed;let upgrade;
    this.navigationCleanup?.();const navigate=(e,u)=>{const next=contentNavigation(u,url,record.platform);if(!next.allowed){e.preventDefault();if(next.upgrade)upgrade=next.upgrade;}};
    for(const event of ['will-navigate','will-redirect'])w.webContents.on(event,navigate);
    this.navigationCleanup=()=>{if(!w.isDestroyed())for(const event of ['will-navigate','will-redirect'])w.webContents.removeListener(event,navigate);};
    const pending=new Map(), debuggerApi=w.webContents.debugger;
    if(debuggerApi.isAttached())debuggerApi.detach();debuggerApi.removeAllListeners('message');debuggerApi.attach('1.3');
    debuggerApi.on('message',async(_e,method,p)=>{
      if(w!==this.window||w.isDestroyed()||this.scope!==record)return;
      if(method==='Network.requestWillBeSent'){
        try{const u=new URL(p.request.url),post=JSON.parse(p.request.postData || '{}');
          const search=record.platform==='小红书'&&u.hostname==='edith.xiaohongshu.com'&&u.pathname==='/api/sns/web/v1/search/notes'&&post.keyword===record.keyword;
          const detail=record.platform==='小红书'&&u.hostname==='edith.xiaohongshu.com'&&u.pathname==='/api/sns/web/v1/feed'&&post.source_note_id===record.detailId;
          const douyin=record.platform==='抖音'&&u.hostname==='www.douyin.com'&&/^\/aweme\/v1\/web\/(?:general\/search\/single|search\/item)\/?$/.test(u.pathname)&&u.searchParams.get('keyword')===record.keyword;
          if((search||detail||douyin)&&pending.size<40&&!this.networkSignal?.aborted)pending.set(p.requestId,{platform:record.platform,detail,token:post.xsec_token,signal:this.networkSignal});
        }catch{}
      }else if(method==='Network.loadingFailed'){
        const request=pending.get(p.requestId);pending.delete(p.requestId);
        if(request&&!request.signal?.aborted&&!p.canceled){const failure=contentLoadError(Error(p.errorText||'官方作品接口网络读取失败'));this.networkError=failure.message;this.networkAction=failure.action;}
      }
      else if(method==='Network.loadingFinished'&&pending.has(p.requestId)){
        const scope=pending.get(p.requestId);pending.delete(p.requestId);if(scope.signal?.aborted)return;if(p.encodedDataLength>6*1024*1024){this.networkError='官方作品接口响应过大，已有结果保留，请稍后继续。';this.networkAction=contentAction('page',this.networkError);return;}
        try{const b=await debuggerApi.sendCommand('Network.getResponseBody',{requestId:p.requestId});if(b.body.length>8*1024*1024){this.networkError='官方作品接口响应过大，已有结果保留，请稍后继续。';this.networkAction=contentAction('page',this.networkError);return;}
          const data=JSON.parse(b.base64Encoded?Buffer.from(b.body,'base64').toString('utf8'):b.body);
          if(w!==this.window||this.scope!==record||scope.signal?.aborted)return; let items=[];
          if(scope.platform==='小红书'&&data.success!==true)this.networkError=`小红书作品接口读取失败（${String(data.code??'未知错误')}）：${String(data.msg||data.message||'请检查登录或验证').slice(0,200)}。已有结果保留，可继续读取。`;
          if(scope.platform==='抖音'&&data.status_code!==0)this.networkError=`抖音作品接口读取失败（${String(data.status_code??'未知错误')}）：${String(data.status_msg||'请检查登录或验证').slice(0,200)}。已有结果保留，可继续读取。`;
          if(scope.platform==='小红书'&&data.success!==true||scope.platform==='抖音'&&data.status_code!==0){const reason=String(data.msg||data.message||data.status_msg||'');this.networkAction=contentAction(/验证码|安全验证/.test(reason)?'verification':/登录|未认证/.test(reason)?'login':'page',this.networkError);}
          if(scope.platform==='小红书'&&data.success===true){items=(data.data?.items||[]).filter(r=>r.model_type!=='rec_query'&&r.model_type!=='hot_query').map(r=>xhsContent(r,scope.token));if(data.data?.has_more===false)this.complete=true;}
          if(scope.platform==='抖音'&&data.status_code===0){items=(data.data||data.aweme_list||[]).map(r=>douyinContent(r.aweme_info||r));if(data.has_more===0)this.complete=true;}
          for(const item of items.filter(Boolean))this.items.set(item.id,mergeContent(this.items.get(item.id),item));
          if(items.some(Boolean)&&!scope.signal?.aborted&&this.scope===record)this.onProgress?.({items:[...this.items.values()],metadataPending:true});
        }catch{if(w===this.window&&this.scope===record&&!scope.signal?.aborted){this.networkError='官方作品接口响应读取失败，已有结果保留，请检查官方窗口后继续。';this.networkAction=contentAction('page',this.networkError);}}
      }
    });
    // Chromium may not acknowledge Network.enable until the first page exists.
    // Keep navigation independent of that acknowledgment, as CreatorBrowser does.
    void debuggerApi.sendCommand('Network.enable',{maxResourceBufferSize:6*1024*1024,maxTotalBufferSize:12*1024*1024}).catch(()=>{});
    const abort=()=>this.close();signal.addEventListener('abort',abort,{once:true});
    try{
      if(w.externalTab&&record.platform==='抖音'&&record.keyword&&!record.detailId){
        this.pendingDouyinSearch=true;
        for(let retry=0;retry<(autoRetry?2:1);retry++){
          try{await openDouyinSearch(w,record.keyword,signal,{restart:true,navigate:target=>navigateOfficialPage(w,target,{userAgent:officialUserAgent,early:false,signal,allowed})});break;}
          catch(error){if(retry||!autoRetry||!transientNavigationError(error)||signal.aborted||w.isDestroyed()){error.recoveryAttempts=retry;throw error;}this.autoRecoveryUsed=true;await delay(350,undefined,{signal});}
        }
        this.pendingDouyinSearch=false;
      }else{
        let next=url;const visited=new Set();for(let attempt=0;attempt<4;attempt++){signal.throwIfAborted();if(visited.has(next))throw Error('官方页面重复跳转，请在官方窗口检查登录或验证');visited.add(next);upgrade=null;for(let retry=0;retry<(autoRetry?2:1);retry++){try{await navigateOfficialPage(w,next,{userAgent:officialUserAgent,early,signal,allowed});break;}catch(e){if(upgrade)break;if(retry||!autoRetry||!transientNavigationError(e)||signal.aborted||w.isDestroyed()){e.recoveryAttempts=retry;throw e;}this.autoRecoveryUsed=true;await delay(350,undefined,{signal});}}if(!upgrade)break;if(attempt===3)throw Error('官方页面跳转次数过多');next=upgrade;}
      }
    }
    catch(e){if(signal.aborted)throw new Error('已停止搜索');if(e.keepWindow){this.show();throw e;}if(!/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(e.message)||w.isDestroyed()||!allowed(w.webContents.getURL())){this.close();throw contentLoadError(e);}}
    finally{signal.removeEventListener('abort',abort);}
    return w;
  }
  async read(record, signal, initial=false,onProgress=()=>{}){
    if(this.networkSignal?.aborted){this.networkError=null;this.networkAction=null;}
    this.onProgress=onProgress;this.networkSignal=signal;
    const resumeAt=initial?0:record.browserScroll||0;
    try{
      if(initial||!this.window||this.window.isDestroyed()||this.recordId!==record.id)await this.open(contentSearchURL(record.platform,record.keyword,record.options),record,signal,{early:true});
      else if(this.pendingDouyinSearch&&this.window.externalTab&&record.platform==='抖音'){
        await openDouyinSearch(this.window,record.keyword,signal);this.pendingDouyinSearch=false;
      }
    }catch(e){this.onProgress=null;throw signal.aborted?e:contentLoadError(e);}
    let w=this.window,snapshot,verified=false,serviceRetried=!!this.autoRecoveryUsed;const seen=new Set(this.items.keys());let stable=0;
    const abort=()=>this.pause();signal.addEventListener('abort',abort,{once:true});
    try{
      for(let i=0;i<12;i++){
        signal.throwIfAborted();if(w.isDestroyed())throw new Error('官方搜索窗口已关闭，请重新搜索');
        try{
          if(record.platform==='抖音'){
            const state=await w.webContents.executeJavaScript(`(${douyinPageState.toString()})()`);
            if(state.retryable)throw Object.assign(Error('抖音官方搜索暂时不可用；'+(serviceRetried?'本次已自动重连，已有结果保留。':'正在自动重新连接。')),{code:'OFFICIAL_SERVICE_UNAVAILABLE',action:contentAction('network','抖音官网当前服务暂不可用，请稍后继续。')});
          }
          snapshot=await w.webContents.executeJavaScript(`(${renderedContent.toString()})(${JSON.stringify(record.platform)},${JSON.stringify(record.keyword)})`);
        }catch(error){
          if(signal.aborted)throw error;
          if(!serviceRetried&&!w.isDestroyed()&&transientNavigationError(error)){
            serviceRetried=true;const preserved=new Map(this.items);
            await this.open(contentSearchURL(record.platform,record.keyword,record.options),record,signal,{reuse:true,early:true,autoRetry:false});w=this.window;
            for(const [id,item] of preserved)this.items.set(id,mergeContent(item,this.items.get(id)));continue;
          }
          throw contentLoadError(error);
        }
        signal.throwIfAborted();
        for(const raw of snapshot.items||[]){const item=contentItem(record.platform,raw);if(item)this.items.set(item.id,mergeContent(this.items.get(item.id),item));}
        if(!w.externalTab&&snapshot.reason==='device-limit'&&record.accountId)this.accounts.markExpired?.(record.platform,record.accountId,snapshot.message);
        if(!w.externalTab&&!verified&&snapshot.loggedIn&&this.items.size&&record.accountId){this.accounts.markVerified?.(record.platform,record.accountId,'已确认官方页面登录并成功读取作品；平台过期或设备超限时需重新登录');verified=true;}
        if(this.networkError){snapshot.blocked=true;snapshot.message=this.networkError;snapshot.action=this.networkAction||contentAction(/验证码|安全验证/.test(this.networkError)?'verification':/登录|失效/.test(this.networkError)?'login':'page',this.networkError);snapshot.complete=false;snapshot.empty=false;}
        const stop=onProgress({items:[...this.items.values()],needsAction:!!snapshot.blocked,message:snapshot.blocked?snapshot.message:undefined,action:snapshot.blocked?snapshot.action||contentAction(snapshot.reason,snapshot.message):undefined});if(snapshot.blocked)this.show();
        if(stop||snapshot.blocked||snapshot.empty||snapshot.complete||this.complete)break;
        const enough=[...this.items.values()].filter(r=>r.publishedAt?r.publishedAt>=record.options.from&&r.publishedAt<=record.options.to:record.options.includeUnknown).length>=record.options.limit;
        if(enough)break;
        if([...this.items.keys()].every(id=>seen.has(id)))stable++;else stable=0;
        this.items.forEach((_v,id)=>seen.add(id));if(stable>=4&&i>=5&&(this.scrollSteps||0)>=resumeAt)break;
        await w.webContents.executeJavaScript('window.scrollBy(0,Math.max(600,window.innerHeight*.8));');this.scrollSteps=(this.scrollSteps||0)+1;record.browserScroll=Math.max(resumeAt,this.scrollSteps);await delay(1000,undefined,{signal});
      }
      if(!this.items.size&&!snapshot.blocked&&!snapshot.empty){snapshot.blocked=true;snapshot.message='官方搜索页面尚未返回可读取的作品，请在官方窗口检查页面加载、登录或验证后继续。';snapshot.action=contentAction('page',snapshot.message);this.show();}
      return {items:[...this.items.values()],complete:!snapshot.blocked&&!!(snapshot.empty||snapshot.complete||this.complete),needsAction:!!snapshot.blocked,action:snapshot.blocked?snapshot.action||contentAction(snapshot.reason,snapshot.message):undefined,message:snapshot.blocked?snapshot.message:(this.scrollSteps||0)<resumeAt?'官方窗口已重建，正在逐批恢复此前读取位置，可继续读取。':'已读取官方页面展示的作品；未公开日期的条目单独标记。'};
    }finally{signal.removeEventListener('abort',abort);this.onProgress=null;if(!signal.aborted){this.networkError=null;this.networkAction=null;}}
  }
  async selectDouyinWork(item,signal,{sourceBrowser=this}={}){
    // Source tasks retain ownership while CommentWorkflow borrows their tab.
    const w=sourceBrowser?.window;
    if(!w||w.isDestroyed()||!w.externalTab)throw Object.assign(Error('原抖音搜索或博主窗口已不可用，请打开包含目标作品的原页面后继续。'),{needsAction:true});
    return selectVisibleDouyinWork(w,item,signal);
  }
  async detail(item,accountId,signal,{metadataOnly=false,reuse=false}={}){
    if(item.platform==='YouTube'&&metadataOnly){
      const record={id:'detail-'+item.id,detailId:item.id,platform:item.platform,accountId},w=await this.open(item.url,record,signal,{reuse,early:true});
      for(let i=0;i<6;i++){signal.throwIfAborted();if(w.isDestroyed())throw Error('官方详情窗口已关闭');const r=await w.webContents.executeJavaScript(`(${renderedContent.toString()})('YouTube','',true)`);signal.throwIfAborted();if(r.blocked){this.show();throw Object.assign(Error(r.message),{needsAction:true,keepWindow:true,action:r.action||contentAction(r.reason,r.message)});}if(r.detail?.id===item.id&&/^\d{4}-\d{2}-\d{2}$/.test(r.detail.publishedAt||''))return {...item,publishedAt:r.detail.publishedAt,publishedAtSource:'exact'};await delay(300,undefined,{signal});}
      throw Error('这条视频尚未返回确切发布时间，已有结果保留');
    }

    if(item.platform==='小红书'){
      const record={id:'detail-'+item.id,detailId:item.id,platform:item.platform,accountId};const w=await this.open(item.url,record,signal,{reuse,early:metadataOnly});
      for(let i=0;i<8;i++){signal.throwIfAborted();if(w.isDestroyed())throw new Error('官方详情窗口已关闭');const result=await w.webContents.executeJavaScript(`(${renderedContent.toString()})('小红书','',true)`);signal.throwIfAborted();if(result.blocked||result.unavailable){if(result.blocked){this.show();if(!w.externalTab&&result.reason==='device-limit'&&accountId)this.accounts.markExpired?.(item.platform,accountId,result.message);}throw Object.assign(new Error(result.message),result.blocked?{needsAction:true,keepWindow:true,action:result.action||contentAction(result.reason,result.message)}:{});}const found=mergeContent(mergeContent(this.items.get(item.id),xhsContent(result.note)),contentItem(item.platform,result.detail));if(found?.id===item.id&&(metadataOnly?found.publishedAt:found.bodyComplete))return found;await delay(metadataOnly?300:800,undefined,{signal});}
      throw new Error(metadataOnly?'这篇笔记尚未返回确切发布时间，已有结果保留，可继续补查':'尚未取得这篇笔记的完整正文，请在官方窗口检查页面后重试克隆');
    }
    return item;
  }
}
