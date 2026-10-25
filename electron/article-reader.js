import {BrowserWindow,session,nativeImage} from 'electron';
import {setTimeout as delay} from 'node:timers/promises';
import {ContentBrowser} from './content-browser.js';
import {CreatorBrowser} from './creator-browser.js';
import {navigateOfficialPage} from './browser-navigation.js';
import {articleURL,articleIdentity,imageURL} from './article-data.js';

const needsAction=message=>Object.assign(Error(message),{needsAction:true});
export function articleNavigation(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['mp.weixin.qq.com','weixin.sogou.com','www.xiaohongshu.com','xiaohongshu.com','xhslink.com','www.xhslink.com'].includes(u.hostname);}catch{return false;}}

export function renderedArticle(metadataOnly=false){
  const root=document.querySelector('#js_content'),title=document.querySelector('#activity-name')?.textContent?.trim();
  if(!root||!title){const text=(document.body?.innerText||'').slice(0,600),permanent=/已删除|无法查看|内容不存在|违规/.test(text);return {permanent,error:/已迁移/.test(text)?'公众号已迁移，请在原文窗口点击“访问文章”，然后重试。':permanent?'文章已删除或无法查看。':/验证码|验证|环境异常|访问过于频繁/.test(text)?'请在原文窗口完成验证后重试。':'未取得文章正文，请检查原文窗口的登录或页面加载。'};}
  const metadata={title,author:document.querySelector('#js_name')?.textContent?.trim()||'',publishedAt:document.querySelector('#publish_time')?.textContent?.trim()||null,url:location.href,thumbnail:document.querySelector('meta[property="og:image"]')?.content||root.querySelector('img[data-src],img[src]')?.getAttribute('data-src')||root.querySelector('img[src]')?.src||''};
  if(metadataOnly)return {...metadata,sourceIdentity:{biz:typeof window.biz==='string'?window.biz:'',mid:String(window.mid||window.appmsgid||''),idx:String(window.idx||'')}};
  const blocks=[];let buffer='';const flush=()=>{const text=buffer.replace(/\u00a0/g,' ').trim();if(text)blocks.push({type:'text',text});buffer='';};
  function walk(node){
    if(node.nodeType===3){buffer+=node.textContent;return;}if(node.nodeType!==1)return;
    if(['SCRIPT','STYLE','NOSCRIPT','IFRAME','VIDEO','AUDIO','SVG'].includes(node.tagName))return;
    if(node.tagName==='IMG'){flush();const url=node.getAttribute('data-src')||node.getAttribute('src');if(url&&!url.startsWith('data:'))try{const u=new URL(url,location.href);u.hash='';blocks.push({type:'image',url:u.href});}catch{}return;}
    if(node.tagName==='BR'){flush();return;}const block=['P','DIV','SECTION','H1','H2','H3','H4','LI','TR','BLOCKQUOTE','PRE'].includes(node.tagName);if(block)flush();
    for(const child of node.childNodes)walk(child);if(block)flush();
  }
  walk(root);flush();
  if(blocks.reduce((n,b)=>n+(b.text?.length||0),0)>300000)return {permanent:true,error:'正文超过 30 万字限制，未保存截断内容。'};
  const canonical=document.querySelector('link[rel="canonical"]')?.href||document.querySelector('meta[property="og:url"]')?.content||(typeof window.msg_link==='string'?window.msg_link:null);
  const sourceIdentity={biz:typeof window.biz==='string'?window.biz:'',mid:String(window.mid||window.appmsgid||''),idx:String(window.idx||'')};
  return {title,author:document.querySelector('#js_name')?.textContent?.trim()||'',publishedAt:document.querySelector('#publish_time')?.textContent?.trim()||null,url:canonical||location.href,sourceIdentity,blocks,images:blocks.filter(b=>b.type==='image').map(b=>b.url),hasEmbeddedMedia:!!root.querySelector('iframe,video,audio')};
}

export function renderedArticleList(kind){
  const body=document.body?.innerText||'',items=[];
  if(/验证码|访问过于频繁|环境异常/.test(document.title+' '+body.slice(0,500)))return {items,needsAction:true,message:'请在列表窗口完成页面验证，然后继续读取。'};
  if(kind==='sogou'){
    for(const card of document.querySelectorAll('.news-list li')){const a=card.querySelector('h3 a');if(a)items.push({url:a.href,title:a.textContent.trim(),author:card.querySelector('.all-time-y2')?.textContent.trim()||'',publishedAt:card.querySelector('.s2')?.innerText.trim()||null});}
    const needsAction=!items.length&&!/没有找到|未找到相关/.test(body);
    return {items,next:document.querySelector('#sogou_next')?.href||null,needsAction,complete:!needsAction&&!document.querySelector('#sogou_next'),message:needsAction?'搜索页面尚未返回结果，请打开采集窗口检查后继续。':'搜狗微信已收录的公开文章；索引可能遗漏或滞后，不代表公众号完整历史。'};
  }
  if(kind==='xhs-profile'){
    const tab=document.querySelector('.user-page .tabs .active,.user-page .tabs .selected')?.textContent||'';
    if(/收藏|点赞/.test(tab))return {items,needsAction:true,message:'请在博主主页选择“笔记”，再继续读取。'};
    const root=document.querySelector('.user-page .feeds-container,.user .feeds-container,.user-page .note-list');
    if(!root)return {items,needsAction:true,message:'未取得博主笔记列表，请在官方窗口完成登录或验证。'};
    for(const card of root.querySelectorAll('.note-item')){
      if(card.querySelector('.play-icon,.video-icon,[class*="video"],use[href*="video"]'))continue;
      const a=[...card.querySelectorAll('a[href]')].find(a=>/\/(?:explore|discovery\/item)\/[a-f\d]{24}/i.test(a.pathname));
      if(a)items.push({url:a.href,title:card.querySelector('.title')?.textContent.trim()||'待获取标题',author:document.querySelector('.user-name')?.textContent.trim()||''});
    }
    return {items,complete:/没有更多了|全部作品已加载/.test(root.innerText),message:'从博主发布的笔记列表读取图文；正文保存时再次检查内容类型。'};
  }
  for(const a of document.querySelectorAll('a[href]'))try{const u=new URL(a.href);if(u.hostname==='mp.weixin.qq.com'&&/^\/s(?:\/[-\w]+)?$/.test(u.pathname))items.push({url:u.href,title:a.textContent.trim()||'待获取标题'});}catch{}
  for(const e of document.querySelectorAll('[data-link]')){const url=e.getAttribute('data-link');if(url?.includes('mp.weixin.qq.com/s'))items.push({url,title:(e.getAttribute('data-title')||e.innerText).replace(/\s+/g,' ').trim().slice(0,200)||'待获取标题',publishedAt:e.innerText.match(/20\d{2}年\d{2}月\d{2}日/)?.[0]||null});}
  return {items,complete:/没有更多了|已无更多/.test(body),needsAction:!items.length,message:items.length?'已读取此公开列表展示的文章，可继续加载。':'列表尚未提供文章链接，请在原文窗口检查登录、列表权限，或使用公众号名称搜索已收录文章。'};
}

export class ArticleReader {
  constructor(accounts,{externalBrowser}={}){
    if(externalBrowser){const original=accounts;accounts=Object.create(original);accounts.externalBrowser=externalBrowser;accounts.usesExternal=platform=>platform==='小红书';accounts.active=platform=>original.active(platform);accounts.markVerified=()=>{};accounts.markExpired=()=>{};this.ownedBrowser=externalBrowser;}
    this.accounts=accounts;this.detail=new ContentBrowser(accounts);this.detail.hidden=true;this.search=new ContentBrowser(accounts);this.search.hidden=true;this.profile=new CreatorBrowser(accounts,null);this.window=null;this.actionWindow=null;this.partition='persist:fengsha-articles';
  }
  close(){this.detail.close();this.search.close();this.profile.close();for(const w of [this.window,this.decoder])if(w&&!w.isDestroyed())w.destroy();this.window=null;this.decoder=null;this.actionWindow=null;this.pendingArticle=null;}
  show(){const w=this.actionWindow||this.window||this.detail.window||this.search.window||this.profile.window;if(w&&!w.isDestroyed()){w.show();w.focus();}}
  async shutdown(){this.close();await this.ownedBrowser?.close();}
  async open(url,signal){
    if(!articleNavigation(url))throw Error('文章页面跳转超出支持的平台范围');
    if(!this.window||this.window.isDestroyed()){
      const s=session.fromPartition(this.partition);s.setPermissionRequestHandler((_w,_p,done)=>done(false));s.setPermissionCheckHandler(()=>false);
      const w=this.window=new BrowserWindow({show:false,width:1100,height:800,title:'文章采集 · 原文窗口',autoHideMenuBar:true,webPreferences:{session:s,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      w.setMenu(null);w.webContents.setAudioMuted(true);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      for(const event of ['will-navigate','will-redirect'])w.webContents.on(event,(e,target)=>{if(!articleNavigation(target))e.preventDefault();});
      s.removeAllListeners('will-download');s.on('will-download',e=>e.preventDefault());
    }
    const w=this.window;this.actionWindow=w;
    await navigateOfficialPage(w,url,{signal,allowed:articleNavigation,timeoutMs:25000,early:true});signal.throwIfAborted();return w;
  }
  async read(value,signal,{metadataOnly=false}={}){
    let item=articleURL(value,{result:true}),url=item.url;
    if(item.platform==='小红书'){
      if(new URL(url).hostname.endsWith('xhslink.com')){const w=await this.open(url,signal);for(let i=0;i<15&&!/xiaohongshu.com/.test(new URL(w.webContents.getURL()).hostname);i++)await delay(300,undefined,{signal});item=articleURL(w.webContents.getURL());url=item.url;}
      const id=new URL(url).pathname.match(/[a-f\d]{24}/i)?.[0];if(!id)throw Error('短链接未返回笔记详情，请检查原文窗口');
      let found;try{found=await this.detail.detail({id,platform:'小红书',url},this.accounts.active('小红书')?.id||null,signal);}finally{this.actionWindow=this.detail.window;}
      if(found.type!=='image')throw Error('这是视频笔记，请使用原有视频下载功能');
      return {...item,...found,id:item.id,blocks:[{type:'text',text:found.text},...found.images.map(url=>({type:'image',url}))]};
    }
    const previous=this.window&&!this.window.isDestroyed()&&this.pendingArticle===url&&this.pendingDocumentURL===this.window.webContents.getURL()?this.window:null;
    const w=previous||await this.open(url,signal);this.pendingArticle=url;this.actionWindow=w;let article;
    for(let i=0;i<15;i++){
      signal.throwIfAborted();article=await w.webContents.executeJavaScript(`(${renderedArticle.toString()})(${metadataOnly})`);
      if(!article.error){const parsed=articleURL(article.url),requested=new URL(url);if(parsed.platform!=='公众号'||requested.searchParams.has('__biz')&&requested.searchParams.has('mid')&&articleIdentity(article).id!==articleURL(url).id)throw Error('原文页面身份不匹配');this.pendingArticle=null;return {...article,url:parsed.url};}
      if(/迁移|删除|验证|无法查看/.test(article.error))break;await delay(400,undefined,{signal});
    }
    if(article?.permanent){this.pendingArticle=null;throw Error(article.error);}this.pendingDocumentURL=w.webContents.getURL();this.show();throw needsAction(article?.error||'未取得文章正文，请检查原文窗口');
  }
  async discover(request,previous,signal){
    const {platform,mode,input,limit}=request;
    if(mode==='author'&&/^https?:/.test(input)&&!/^\/mp\//.test(new URL(input).pathname)&&!/^\/user\/profile\//.test(new URL(input).pathname)){
      let context=previous?.authorContext;
      if(!context){
        const article=await this.read(input,signal);signal.throwIfAborted();
        if(!article.author)throw Error('原文未提供作者信息，请粘贴作者主页或公众号准确名称');
        let source=article.author;
        if(platform==='小红书')source=await this.detail.window.webContents.executeJavaScript(`document.querySelector('.author-container a[href*="/user/profile/"],.note-container .author a[href*="/user/profile/"]')?.href||null`);
        if(!source)throw Error('笔记未提供作者主页，请直接粘贴博主主页链接');
        context={input:source,name:article.author,biz:article.sourceIdentity?.biz||null,seed:{...articleURL(article.url),title:article.title,author:article.author,publishedAt:article.publishedAt}};
      }
      const page=await this.discover({...request,input:context.input},previous,signal);
      const combined=previous?page.items:[context.seed,...page.items.filter(i=>i.url!==context.seed.url)],overflow=[...combined.slice(limit),...(page.overflow||[])];
      return {...page,authorContext:context,items:combined.slice(0,limit),overflow,complete:page.complete&&!overflow.length,message:`已识别作者：${context.name}。${page.message||''} 原文已列入清单；搜索索引不保证完整历史，保存时核对作者身份。`};
    }
    if(previous?.overflow?.length){const items=previous.overflow.slice(0,limit),overflow=previous.overflow.slice(limit);return {items,overflow,next:previous.next,endReached:previous.endReached,complete:previous.endReached&&!overflow.length,message:previous.message};}
    if(platform==='小红书'&&mode==='search'){
      const target=Math.min(500,(previous?.items.length||0)+limit),record=this.searchRecord=previous&&this.searchRecord||{id:'article-search-'+Date.now(),platform,keyword:input,accountId:this.accounts.active(platform)?.id||null,options:{from:'2000-01-01',to:'2099-12-31',includeUnknown:true,limit:500}};
      const page=await this.search.read(record,signal,!previous,page=>(page.items||[]).filter(i=>i.type==='image').length>=target);this.actionWindow=this.search.window;
      const candidates=page.items.filter(i=>i.type==='image');return {...page,complete:page.complete&&candidates.length<=target,items:candidates.slice(0,target),message:page.needsAction?page.message:'已读取小红书搜索结果中的图文笔记；视频结果不进入文章库。'};
    }
    if(platform==='小红书'){
      const source=articleURL(input,{list:true});const id=new URL(source.url).pathname.match(/\/user\/profile\/([a-f\d]{24})/i)?.[1];if(!id)throw Error('批量采集请粘贴小红书博主主页链接');
      const w=await this.profile.open(source.url,platform,this.accounts.active(platform)?.id||null,signal,false);this.actionWindow=w;
      const seen=new Set(previous?.items.map(i=>i.id)||[]),items=new Map();let page;
      for(let i=0;i<6;i++){signal.throwIfAborted();if(new URL(w.webContents.getURL()).pathname.replace(/\/$/,'')!==`/user/profile/${id}`)throw needsAction('官方窗口已离开当前博主主页');page=await w.webContents.executeJavaScript(`(${renderedArticleList.toString()})('xhs-profile')`);for(const item of page.items)if(!seen.has(articleURL(item.url).id))items.set(item.url,item);if(page.needsAction||page.complete||items.size>=limit)break;await w.webContents.executeJavaScript('window.scrollTo(0,document.documentElement.scrollHeight)');await delay(1000,undefined,{signal});}
      if(page.needsAction)this.show();return {...page,complete:page.complete&&items.size<=limit,items:[...items.values()].slice(0,limit)};
    }
    const official=mode==='author'&&/^https?:/.test(input),kind=official?'wechat-list':'sogou';
    let url=official?articleURL(input,{list:true}).url:`https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(input)}`;
    if(previous?.next){if(!articleNavigation(previous.next)||new URL(previous.next).hostname!=='weixin.sogou.com')throw Error('搜索下一页地址无效');url=previous.next;}
    const reuse=official&&previous&&this.window&&!this.window.isDestroyed()&&this.window.webContents.getURL()===url;
    const w=reuse?this.window:await this.open(url,signal);await delay(500,undefined,{signal});const seen=new Set(previous?.items.map(i=>i.id)||[]),items=new Map();let page;
    for(let i=0;i<(official?5:1);i++){
      page=await w.webContents.executeJavaScript(`(${renderedArticleList.toString()})(${JSON.stringify(kind)})`);signal.throwIfAborted();
      for(const item of page.items)try{const parsed=articleURL(item.url,{result:true});if(official&&seen.has(parsed.id)||mode==='author'&&!official&&item.author!==input)continue;items.set(item.url,item);}catch{}
      if(page.needsAction||page.complete||items.size>=limit||!official)break;await w.webContents.executeJavaScript('window.scrollTo(0,document.documentElement.scrollHeight)');await delay(700,undefined,{signal});
    }
    if(page.needsAction)this.show();
    const found=[...items.values()];return {...page,endReached:!!page.complete,complete:page.complete&&items.size<=limit,items:found.slice(0,limit),overflow:official?[]:found.slice(limit),message:page.needsAction?page.message:!official&&mode==='author'?`按公众号名称“${input}”精确筛选搜索索引，不代表完整历史。${items.size?'':page.next?'本页无匹配，可继续下一页。':'索引未收录其他匹配文章。'}`:page.message};
  }
  async image(value,signal){
    const url=imageURL(value),timeout=AbortSignal.timeout(20000),combined=AbortSignal.any([signal,timeout]);
    const response=await session.fromPartition(this.partition).fetch(url,{signal:combined,redirect:'error',headers:{Referer:url.includes('xhscdn.com')?'https://www.xiaohongshu.com/':'https://mp.weixin.qq.com/'}});
    if(!response.ok)throw Error(`图片请求失败 (${response.status})`);if(Number(response.headers.get('content-length'))>20*1024*1024){await response.body?.cancel();throw Error('图片超过 20 MB');}
    const reader=response.body.getReader(),chunks=[];let size=0;try{for(;;){combined.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20*1024*1024)throw Error('图片超过 20 MB');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const bytes=Buffer.concat(chunks);let ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216?'jpg':bytes.subarray(0,3).toString()==='GIF'?'gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':null;
    if(!ext)throw Error('响应不是支持的图片格式');
    // NativeImage cannot decode every WebP/GIF supported by Chromium. Validate
    // those in an isolated blank renderer and retain original animation bytes.
    if(nativeImage.createFromBuffer(bytes).isEmpty()){
      if(!this.decoder||this.decoder.isDestroyed()){this.decoder=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await this.decoder.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">');}
      signal.throwIfAborted();const data=`data:image/${ext==='jpg'?'jpeg':ext};base64,${bytes.toString('base64')}`;
      const valid=await this.decoder.webContents.executeJavaScript(`new Promise(resolve=>{const image=new Image();let timer;const done=value=>{clearTimeout(timer);image.onload=image.onerror=null;image.src='';resolve(value);};image.onload=()=>done(image.naturalWidth>0&&image.naturalHeight>0);image.onerror=()=>done(false);timer=setTimeout(()=>done(false),5000);image.src=${JSON.stringify(data)};})`);
      signal.throwIfAborted();if(!valid)throw Error('响应不是可解码的图片');
    }
    return {bytes,ext};
  }
}
