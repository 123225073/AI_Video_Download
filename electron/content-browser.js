import { BrowserWindow } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { contentItem, xhsContent, douyinContent } from './content-data.js';
import {contentLoadMessage} from './content-network.js';
import {contentNavigation} from './content-navigation.js';
export function contentSearchURL(platform, keyword) {
  const q = encodeURIComponent(keyword);
  return { '小红书':`https://www.xiaohongshu.com/search_result/?keyword=${q}&source=web_explore_feed&type=0`, '抖音':`https://www.douyin.com/search/${q}?type=video`, YouTube:`https://www.youtube.com/results?search_query=${q}&sp=CAI%253D` }[platform];
}
// Only fields needed for the selected work are returned; tokens and storage stay in the official session.
export function renderedContent(platform, keyword, detail = false) {
  const here = new URL(location.href), visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const body = document.body?.innerText || '';
  const challenge = /unusual traffic|安全限制|验证码中间页/i.test(document.title) || [...document.querySelectorAll('[class*="captcha"],iframe[src*="captcha"],.login-modal,[data-e2e="login-dialog"]')].some(visible);
  if (challenge) return {blocked:true,message:'请在官方窗口完成登录或验证，已有结果保留。',items:[]};
  if (detail) {
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
    const full = text.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if(full) return `${full[1]}-${full[2].padStart(2,'0')}-${full[3].padStart(2,'0')}`;
    const d=new Date(); const m=text.match(/(\d+)\s*(天|日|周|星期|小时|分钟|days?|weeks?|hours?|minutes?)\s*(前|ago)/i);
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
  return {items,empty:/没有搜索结果|没有找到相关笔记|No results found/.test(body)&&!items.length,complete:/没有更多了|没有更多作品/.test(body)};
}
export class ContentBrowser {
  constructor(accounts){this.accounts=accounts;this.window=null;this.items=new Map();}
  close(){if(this.window&&!this.window.isDestroyed())this.window.close();this.window=null;}
  show(){if(this.window&&!this.window.isDestroyed()){this.window.show();this.window.focus();}}
  async open(url, record, signal) {
    this.close();this.items=new Map();this.recordId=record.id;this.complete=false;
    const s=record.accountId?this.accounts.getSession(record.accountId):undefined;
    const w=this.window=new BrowserWindow({show:!this.hidden,width:1100,height:800,autoHideMenuBar:true,title:'作品搜索 · 完成官方登录或验证后继续',webPreferences:{session:s,partition:s?undefined:`fengsha-content-${record.platform}`,sandbox:true,contextIsolation:true,nodeIntegration:false,autoplayPolicy:'document-user-activation-required'}});
    w.setMenu(null);w.webContents.setAudioMuted(true);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    const allowed=value=>contentNavigation(value,url,record.platform).allowed;let upgrade;
    for(const event of ['will-navigate','will-redirect'])w.webContents.on(event,(e,u)=>{const next=contentNavigation(u,url,record.platform);if(!next.allowed){e.preventDefault();if(next.upgrade)upgrade=next.upgrade;}});
    const pending=new Map(), debuggerApi=w.webContents.debugger;
    debuggerApi.attach('1.3');
    debuggerApi.on('message',async(_e,method,p)=>{
      if(w!==this.window||w.isDestroyed())return;
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
          if(w!==this.window)return; let items=[];
          if(scope.platform==='小红书'&&data.success===true){items=(data.data?.items||[]).filter(r=>r.model_type!=='rec_query'&&r.model_type!=='hot_query').map(r=>xhsContent(r,scope.token));if(data.data?.has_more===false)this.complete=true;}
          if(scope.platform==='抖音'&&data.status_code===0){items=(data.data||data.aweme_list||[]).map(r=>douyinContent(r.aweme_info||r));if(data.has_more===0)this.complete=true;}
          for(const item of items.filter(Boolean)){this.items.set(item.id,item);if(this.items.size>1000)this.items.delete(this.items.keys().next().value);}
        }catch{} // A navigation can dispose a body; renderer fallback remains bounded.
      }
    });
    // Chromium may not acknowledge Network.enable until the first page exists.
    // Keep navigation independent of that acknowledgment, as CreatorBrowser does.
    void debuggerApi.sendCommand('Network.enable',{maxResourceBufferSize:6*1024*1024,maxTotalBufferSize:12*1024*1024}).catch(()=>{});
    const abort=()=>this.close();signal.addEventListener('abort',abort,{once:true});
    try{let next=url;const visited=new Set();for(let attempt=0;attempt<4;attempt++){signal.throwIfAborted();if(visited.has(next))throw Error('官方页面重复跳转，请在官方窗口检查登录或验证');visited.add(next);upgrade=null;try{await w.loadURL(next,{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'});if(!upgrade)break;}catch(e){if(!upgrade)throw e;}if(upgrade&&attempt===3)throw Error('官方页面跳转次数过多');next=upgrade;}}
    catch(e){if(signal.aborted)throw new Error('已停止搜索');if(!/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(e.message)||w.isDestroyed()||!allowed(w.webContents.getURL())){this.close();throw new Error(contentLoadMessage(e));}}
    finally{signal.removeEventListener('abort',abort);}
    return w;
  }
  async read(record, signal, initial=false){
    if(initial||!this.window||this.window.isDestroyed()||this.recordId!==record.id)await this.open(contentSearchURL(record.platform,record.keyword),record,signal);
    const w=this.window;let snapshot;const seen=new Set(this.items.keys());let stable=0;
    const abort=()=>this.close();signal.addEventListener('abort',abort,{once:true});
    try{
      for(let i=0;i<12;i++){
        signal.throwIfAborted();if(w.isDestroyed())throw new Error('官方搜索窗口已关闭，请重新搜索');
        snapshot=await w.webContents.executeJavaScript(`(${renderedContent.toString()})(${JSON.stringify(record.platform)},${JSON.stringify(record.keyword)})`);
        for(const raw of snapshot.items||[]){const item=contentItem(record.platform,raw);if(item&&!this.items.has(item.id))this.items.set(item.id,item);}
        if(snapshot.blocked||snapshot.empty||snapshot.complete||this.complete)break;
        const enough=[...this.items.values()].filter(r=>r.publishedAt?r.publishedAt>=record.options.from&&r.publishedAt<=record.options.to:record.options.includeUnknown).length>=record.options.limit;
        if(enough)break;
        if([...this.items.keys()].every(id=>seen.has(id)))stable++;else stable=0;
        this.items.forEach((_v,id)=>seen.add(id));if(stable>=4&&i>=5)break;
        await w.webContents.executeJavaScript('window.scrollBy(0,Math.max(600,window.innerHeight*.8));');await delay(1000,undefined,{signal});
      }
      return {items:[...this.items.values()],complete:!!(snapshot.empty||snapshot.complete||this.complete),needsAction:!!snapshot.blocked,message:snapshot.blocked?snapshot.message:'已读取官方页面展示的作品；未公开日期的条目单独标记。'};
    }finally{signal.removeEventListener('abort',abort);}
  }
  async detail(item,accountId,signal){
    if(item.platform==='小红书'){
      const record={id:'detail-'+item.id,detailId:item.id,platform:item.platform,accountId};const w=await this.open(item.url,record,signal);
      for(let i=0;i<8;i++){signal.throwIfAborted();if(w.isDestroyed())throw new Error('官方详情窗口已关闭');const result=await w.webContents.executeJavaScript(`(${renderedContent.toString()})('小红书','',true)`);if(result.blocked||result.unavailable)throw new Error(result.message);const found=this.items.get(item.id)||xhsContent(result.note)||contentItem(item.platform,result.detail);if(found?.id===item.id&&found.bodyComplete)return found;await delay(800,undefined,{signal});}
      throw new Error('尚未取得这篇笔记的完整正文，请在官方窗口完成登录后重试克隆');
    }
    return item;
  }
}
