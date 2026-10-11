import { BrowserWindow } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { contentItem, xhsContent, douyinContent, mergeContent } from './content-data.js';
import { officialUserAgent } from './account-session.js';
import {contentLoadMessage} from './content-network.js';
import {contentNavigation} from './content-navigation.js';
export function contentSearchURL(platform, keyword,options={}) {
  const q = encodeURIComponent(keyword),today=new Date(),month=new Date(today.getFullYear(),today.getMonth()-1,Math.min(today.getDate(),new Date(today.getFullYear(),today.getMonth(),0).getDate())),year=new Date(today.getFullYear()-1,today.getMonth(),today.getDate());
  const from=options.from?new Date(options.from+'T00:00:00'):month,filter=from>=month?'CAISAggE':from>=year?'CAISAggF':'EgIQAfABAQ%253D%253D';
  return { '小红书':`https://www.xiaohongshu.com/search_result/?keyword=${q}&source=web_explore_feed&type=0`, '抖音':`https://www.douyin.com/search/${q}?type=video`, YouTube:`https://www.youtube.com/results?search_query=${q}&sp=${filter}` }[platform];
}
// Only fields needed for the selected work are returned; tokens and storage stay in the official session.
export function renderedContent(platform, keyword, detail = false) {
  const here = new URL(location.href), visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const body = document.body?.innerText || '';
  const deviceLimit=[...document.querySelectorAll('.login-modal,[class*="login-container"]')].some(e=>visible(e)&&/设备登录超限/.test(e.innerText||''));
  if(deviceLimit)return {blocked:true,reason:'device-limit',message:'小红书提示电脑设备登录超限，当前会话已被平台拒绝，请在官方窗口重新登录；已有结果保留。',items:[]};
  const challenge = /unusual traffic|安全限制|验证码中间页/i.test(document.title) || [...document.querySelectorAll('[class*="captcha"],iframe[src*="captcha"],.login-modal,[data-e2e="login-dialog"]')].some(visible);
  if (challenge) return {blocked:true,message:'请在官方窗口完成登录或验证，已有结果保留。',items:[]};
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
  const validPage = platform === 'YouTube' ? here.hostname === 'www.youtube.com' && here.pathname === '/results' && here.searchParams.get('search_query') === keyword
    : platform === '小红书' ? ['www.xiaohongshu.com','xiaohongshu.com'].includes(here.hostname) && here.pathname.replace(/\/+$/,'') === '/search_result' && here.searchParams.get('keyword') === keyword
    : here.hostname === 'www.douyin.com' && decodeURIComponent(here.pathname) === `/search/${keyword}` && here.searchParams.get('type') === 'video';
  if (!validPage) return {blocked:true,message:'官方窗口已离开本次作品搜索，请重新搜索。',items:[]};
  const items=[];
  const dateText = text => {
    if(/编辑|更新|修改/.test(text))return null;
    const full = text.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if(full) return `${full[1]}-${full[2].padStart(2,'0')}-${full[3].padStart(2,'0')}`;
    const d=new Date();const short=text.trim().match(/^(\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+\d{1,2}:\d{2})?$/);
    if(short){let year=d.getFullYear();const month=Number(short[1]),day=Number(short[2]);if(month>d.getMonth()+1||month===d.getMonth()+1&&day>d.getDate())year--;const date=new Date(year,month-1,day);if(date.getMonth()!==month-1||date.getDate()!==day)return null;return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;}
    if(/^(今天|昨天|刚刚)(?:\s|$)/.test(text.trim())){if(text.trim().startsWith('昨天'))d.setDate(d.getDate()-1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
    const m=text.match(/(\d+)\s*(天|日|周|星期|小时|分钟|days?|weeks?|hours?|minutes?)\s*(前|ago)/i);
    if(m) {d.setTime(d.getTime()-Number(m[1])*(/周|星期|weeks?/i.test(m[2])?604800000:/天|日|days?/i.test(m[2])?86400000:/小时|hours?/i.test(m[2])?3600000:60000));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
    return null; // IDs, modification dates and vague month labels are not publication dates.
  };
  const selector=platform==='YouTube'?'ytd-video-renderer':platform==='小红书'?'.feeds-container .note-item,section.note-item':'[data-e2e="search-video-list"] li,[data-e2e="search-video-item"]';
  for(const card of [...document.querySelectorAll(selector)].filter(visible).slice(0,200)) {
    const links=[...card.querySelectorAll('a[href]')].filter(a=>{try{const u=new URL(a.href);return u.origin===here.origin && (platform==='YouTube'?u.pathname==='/watch'&&u.searchParams.has('v'):platform==='小红书'?/^\/(?:explore|discovery\/item|search_result)\/[a-f\d]{24}\/?$/i.test(u.pathname):/\/video\/\d+/.test(u.pathname));}catch{return false;}});
    const a=platform==='小红书'?links.find(a=>new URL(a.href).searchParams.has('xsec_token'))||links[0]:links[0];
    if(!a)continue;const u=new URL(a.href),id=platform==='YouTube'?u.searchParams.get('v'):u.pathname.match(platform==='小红书'?/\/(?:explore|discovery\/item|search_result)\/([a-f\d]{24})/i:/\/video\/(\d+)/)?.[1];
    if(platform==='小红书'&&u.pathname.startsWith('/search_result/'))u.pathname='/explore/'+id;
    items.push({id,url:u.href,title:card.querySelector('#video-title,.title,[data-e2e="video-desc"]')?.textContent || a.title || '',author:card.querySelector('#channel-name,.author .name,[data-e2e="video-author"]')?.textContent || '',thumbnail:card.querySelector('img')?.src || '',publishedAt:dateText(card.querySelector('#metadata-line,.time,.date')?.innerText || ''),type:platform==='小红书'&&!card.querySelector('.play-icon,.video-icon,[class*="video"],use[href*="video"],use[xlink\\:href*="video"]')?'image':'video'});
  }
  const loggedIn=platform==='小红书'&&[...document.querySelectorAll('.side-bar a[href*="/user/profile/"],nav a[href*="/user/profile/"],aside a[href*="/user/profile/"]')].some(e=>visible(e)&&e.innerText.trim()==='我');
  return {items,loggedIn,empty:/没有搜索结果|没有找到相关笔记|No results found/.test(body)&&!items.length,complete:/没有更多了|没有更多作品/.test(body)};
}
export class ContentBrowser {
  constructor(accounts){this.accounts=accounts;this.window=null;this.items=new Map();}
  close(){if(this.window&&!this.window.isDestroyed())this.window.destroy();this.window=null;}
  show(){if(this.window&&!this.window.isDestroyed()){this.window.show();this.window.focus();}}
  async open(url, record, signal, {reuse=false,early=false}={}) {
    const previous=reuse&&this.window&&!this.window.isDestroyed()&&this.accountId===record.accountId?this.window:null;
    if(!previous)this.close();this.items=new Map();this.recordId=record.id;this.complete=false;this.scope=record;this.accountId=record.accountId;
    const s=record.accountId?this.accounts.getSession(record.accountId):undefined;
    const w=this.window=previous||new BrowserWindow({show:!this.hidden,width:1100,height:800,autoHideMenuBar:true,title:'作品搜索 · 完成官方登录或验证后继续',webPreferences:{session:s,partition:s?undefined:`fengsha-content-${record.platform}`,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'document-user-activation-required'}});
    w.setMenu(null);w.webContents.setAudioMuted(true);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
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
          if((search||detail||douyin)&&pending.size<40)pending.set(p.requestId,{platform:record.platform,detail,token:post.xsec_token});
        }catch{}
      }else if(method==='Network.loadingFailed')pending.delete(p.requestId);
      else if(method==='Network.loadingFinished'&&pending.has(p.requestId)){
        const scope=pending.get(p.requestId);pending.delete(p.requestId);if(p.encodedDataLength>6*1024*1024)return;
        try{const b=await debuggerApi.sendCommand('Network.getResponseBody',{requestId:p.requestId});if(b.body.length>8*1024*1024)return;
          const data=JSON.parse(b.base64Encoded?Buffer.from(b.body,'base64').toString('utf8'):b.body);
          if(w!==this.window||this.scope!==record)return; let items=[];
          if(scope.platform==='小红书'&&data.success===true){items=(data.data?.items||[]).filter(r=>r.model_type!=='rec_query'&&r.model_type!=='hot_query').map(r=>xhsContent(r,scope.token));if(data.data?.has_more===false)this.complete=true;}
          if(scope.platform==='抖音'&&data.status_code===0){items=(data.data||data.aweme_list||[]).map(r=>douyinContent(r.aweme_info||r));if(data.has_more===0)this.complete=true;}
          for(const item of items.filter(Boolean)){this.items.set(item.id,mergeContent(this.items.get(item.id),item));if(this.items.size>1000)this.items.delete(this.items.keys().next().value);}
          if(items.some(Boolean)&&!signal.aborted&&this.scope===record)this.onProgress?.({items:[...this.items.values()],metadataPending:true});
        }catch{} // A navigation can dispose a body; renderer fallback remains bounded.
      }
    });
    // Chromium may not acknowledge Network.enable until the first page exists.
    // Keep navigation independent of that acknowledgment, as CreatorBrowser does.
    void debuggerApi.sendCommand('Network.enable',{maxResourceBufferSize:6*1024*1024,maxTotalBufferSize:12*1024*1024}).catch(()=>{});
    const abort=()=>this.close();signal.addEventListener('abort',abort,{once:true});
    try{let next=url;const visited=new Set();for(let attempt=0;attempt<4;attempt++){signal.throwIfAborted();if(visited.has(next))throw Error('官方页面重复跳转，请在官方窗口检查登录或验证');visited.add(next);upgrade=null;let ready,timer;const dom=new Promise(resolve=>{ready=()=>resolve();w.webContents.once('dom-ready',ready);});const timeout=new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('ERR_TIMED_OUT')),30000);});try{await Promise.race([w.loadURL(next,{userAgent:officialUserAgent}),...(early?[dom]:[]),timeout]);if(!upgrade)break;}catch(e){if(!upgrade)throw e;}finally{clearTimeout(timer);if(!w.isDestroyed())w.webContents.removeListener('dom-ready',ready);}if(upgrade&&attempt===3)throw Error('官方页面跳转次数过多');next=upgrade;}}
    catch(e){if(signal.aborted)throw new Error('已停止搜索');if(!/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(e.message)||w.isDestroyed()||!allowed(w.webContents.getURL())){this.close();throw new Error(contentLoadMessage(e));}}
    finally{signal.removeEventListener('abort',abort);}
    return w;
  }
  async read(record, signal, initial=false,onProgress=()=>{}){
    this.onProgress=onProgress;
    try{if(initial||!this.window||this.window.isDestroyed()||this.recordId!==record.id)await this.open(contentSearchURL(record.platform,record.keyword,record.options),record,signal,{early:true});}catch(e){this.onProgress=null;throw e;}
    const w=this.window;let snapshot,verified=false;const seen=new Set(this.items.keys());let stable=0;
    const abort=()=>this.close();signal.addEventListener('abort',abort,{once:true});
    try{
      for(let i=0;i<12;i++){
        signal.throwIfAborted();if(w.isDestroyed())throw new Error('官方搜索窗口已关闭，请重新搜索');
        snapshot=await w.webContents.executeJavaScript(`(${renderedContent.toString()})(${JSON.stringify(record.platform)},${JSON.stringify(record.keyword)})`);
        for(const raw of snapshot.items||[]){const item=contentItem(record.platform,raw);if(item)this.items.set(item.id,mergeContent(this.items.get(item.id),item));}
        if(snapshot.reason==='device-limit'&&record.accountId)this.accounts.markExpired?.(record.platform,record.accountId,snapshot.message);
        if(!verified&&snapshot.loggedIn&&this.items.size&&record.accountId){this.accounts.markVerified?.(record.platform,record.accountId,'已确认官方页面登录并成功读取作品；平台过期或设备超限时需重新登录');verified=true;}
        const stop=onProgress({items:[...this.items.values()],needsAction:!!snapshot.blocked,message:snapshot.blocked?snapshot.message:undefined});if(snapshot.blocked)this.show();
        if(stop||snapshot.blocked||snapshot.empty||snapshot.complete||this.complete)break;
        const enough=[...this.items.values()].filter(r=>r.publishedAt?r.publishedAt>=record.options.from&&r.publishedAt<=record.options.to:record.options.includeUnknown).length>=record.options.limit;
        if(enough)break;
        if([...this.items.keys()].every(id=>seen.has(id)))stable++;else stable=0;
        this.items.forEach((_v,id)=>seen.add(id));if(stable>=4&&i>=5)break;
        await w.webContents.executeJavaScript('window.scrollBy(0,Math.max(600,window.innerHeight*.8));');await delay(1000,undefined,{signal});
      }
      if(!this.items.size&&!snapshot.blocked&&!snapshot.empty){snapshot.blocked=true;snapshot.message='官方搜索页面尚未返回可读取的作品，请在官方窗口检查页面加载、登录或验证后继续。';this.show();}
      return {items:[...this.items.values()],complete:!!(snapshot.empty||snapshot.complete||this.complete),needsAction:!!snapshot.blocked,message:snapshot.blocked?snapshot.message:'已读取官方页面展示的作品；未公开日期的条目单独标记。'};
    }finally{signal.removeEventListener('abort',abort);this.onProgress=null;}
  }
  async detail(item,accountId,signal,{metadataOnly=false,reuse=false}={}){
    if(item.platform==='YouTube'&&metadataOnly){
      const record={id:'detail-'+item.id,detailId:item.id,platform:item.platform,accountId},w=await this.open(item.url,record,signal,{reuse,early:true});
      for(let i=0;i<6;i++){signal.throwIfAborted();if(w.isDestroyed())throw Error('官方详情窗口已关闭');const r=await w.webContents.executeJavaScript(`(${renderedContent.toString()})('YouTube','',true)`);if(r.blocked){this.show();throw Error(r.message);}if(r.detail?.id===item.id&&/^\d{4}-\d{2}-\d{2}$/.test(r.detail.publishedAt||''))return {...item,publishedAt:r.detail.publishedAt};await delay(300,undefined,{signal});}
      throw Error('这条视频尚未返回确切发布时间，已有结果保留');
    }

    if(item.platform==='小红书'){
      const record={id:'detail-'+item.id,detailId:item.id,platform:item.platform,accountId};const w=await this.open(item.url,record,signal,{reuse,early:metadataOnly});
      for(let i=0;i<8;i++){signal.throwIfAborted();if(w.isDestroyed())throw new Error('官方详情窗口已关闭');const result=await w.webContents.executeJavaScript(`(${renderedContent.toString()})('小红书','',true)`);if(result.blocked||result.unavailable){if(result.blocked){this.show();if(result.reason==='device-limit'&&accountId)this.accounts.markExpired?.(item.platform,accountId,result.message);}throw new Error(result.message);}const found=this.items.get(item.id)||xhsContent(result.note)||contentItem(item.platform,result.detail);if(found?.id===item.id&&(metadataOnly?found.publishedAt:found.bodyComplete))return found;await delay(metadataOnly?300:800,undefined,{signal});}
      throw new Error('尚未取得这篇笔记的完整正文，请在官方窗口完成登录后重试克隆');
    }
    return item;
  }
}
