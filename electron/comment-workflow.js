import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {searchUser} from './user-search-data.js';
import {ContentBrowser} from './content-browser.js';
import {thumbnailUrl} from './thumbnail.js';
import {youtubeCommentContext} from './youtube-session.js';
import {douyinPageState} from './douyin-page.js';
export function renderedComments(platform,sourceURL,expand=false,offset=0){
  const source=new URL(sourceURL),here=new URL(location.href);
  const identity=u=>platform==='小红书'?u.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i)?.[1]:platform==='抖音'?(u.searchParams.get('modal_id')||u.pathname.match(/^\/(?:video|note)\/(\d+)\/?$/)?.[1]):platform==='YouTube'?(u.searchParams.get('v')||u.pathname.match(/^\/shorts\/([\w-]+)\/?$/)?.[1]):platform==='B站'?u.pathname.match(/^\/video\/((?:BV|av)[\w]+)\/?$/)?.[1]:null;
  const sourceId=identity(source),sameHost=here.hostname.replace(/^www\./,'')===source.hostname.replace(/^www\./,'');
  if(!sameHost||(sourceId?identity(here)!==sourceId:here.pathname.replace(/\/+$/,'')!==source.pathname.replace(/\/+$/,'')))return {blocked:true,message:'评论窗口已离开所选作品，请重新打开。',comments:[]};
  const visible=e=>e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const textOf=e=>String(e?.innerText??e?.textContent??'').trim();
  const segment=nodes=>{
    const start=Number.isInteger(offset)&&offset>=0&&offset<nodes.length?offset:0;
    const end=start+500;
    return {nodes:nodes.slice(start,end),nextOffset:end<nodes.length?end:0};
  };
  const selectors={ '小红书':'.comments-container .comment-item,.comments-container .parent-comment,.comments-container .sub-comment,.comments-container .comment-item-sub','抖音':'[data-e2e="comment-list"] [data-e2e="comment-item"],[data-e2e="comment-item"]','B站':'.reply-list .root-reply,.reply-list .reply-item,.reply-list .sub-reply-item',YouTube:'#comments ytd-comment-view-model,#comments ytd-comment-renderer','视频号':'.comment-list .comment-item' };
  const selector=selectors[platform]||'.no-supported-comment';
  if(platform==='抖音'&&expand&&![...document.querySelectorAll('[data-e2e="comment-list"]')].some(visible)){
    const button=document.querySelector('[data-e2e="feed-active-video"] [data-e2e="feed-comment-icon"]');
    if(visible(button))button.click();
  }
  const cards=[...document.querySelectorAll(selector)].filter(visible);
  if(/验证码|安全限制|unusual traffic/i.test(document.title)||[...document.querySelectorAll('[class*="captcha"],iframe[src*="captcha"]')].some(visible))return {blocked:true,message:'官方评论页面要求验证，请完成后继续。',comments:[]};
  if(platform==='YouTube'&&[...document.querySelectorAll('yt-playability-error-supported-renderers,ytd-enforcement-message-view-model,#error-screen')].some(e=>visible(e)&&/确认你不是聊天机器人|confirm you.re not a bot/i.test(textOf(e))))return {blocked:true,reason:'login',message:'YouTube 要求登录以确认不是机器人，请在官方评论窗口完成登录后继续；已有评论保留。',comments:[]};
  const loginModal=[...document.querySelectorAll('.login-modal,[data-e2e="login-dialog"]')].find(visible),needsLogin=!!loginModal,deviceLimit=/设备登录超限/.test(textOf(loginModal));
  if(platform==='B站'&&document.querySelector('bili-comments')){
    const container=document.querySelector('bili-comments'),roots=[],visit=root=>{roots.push(root);for(const e of root.querySelectorAll('*'))if(e.shadowRoot)visit(e.shadowRoot);};visit(container.shadowRoot||container);
    const comments=[],batch=segment(roots.flatMap(root=>[...root.querySelectorAll('bili-comment-renderer,bili-comment-reply-renderer')]));
    for(const card of batch.nodes){
      const root=card.shadowRoot;if(!root)continue;
      const text=textOf(root.querySelector('bili-rich-text')?.shadowRoot?.querySelector('#contents'));if(!text)continue;
      const user=root.querySelector('bili-comment-user-info')?.shadowRoot,anchor=user?.querySelector('#user-name a[href]');let id;
      try{const u=new URL(anchor?.getAttribute('href')||'',location.href);if(u.protocol==='https:'&&u.hostname==='space.bilibili.com'&&/^\/\d+\/?$/.test(u.pathname))id=u.pathname.split('/')[1];}catch{}
      let isReply=false;for(let node=card;node;node=node.parentElement||node.getRootNode?.().host){if(/bili-comment-(?:replies|reply)-renderer/.test(node.localName||'')){isReply=true;break;}}
      comments.push({id:card.getAttribute('data-rpid')||'',userId:id,name:textOf(anchor)||textOf(user?.querySelector('#user-name'))||'用户资料未返回',text:text.slice(0,20000),published:textOf(root.querySelector('bili-comment-action-buttons-renderer')?.shadowRoot?.querySelector('#pubdate')),isReply});
    }
    if(expand&&!batch.nextOffset){const scroller=document.scrollingElement;if(scroller)scroller.scrollTop+=Math.max(700,innerHeight*.8);}
    return {comments,nextOffset:batch.nextOffset,blocked:needsLogin,reason:needsLogin?'login':undefined,complete:false,message:needsLogin?'已保存可读取评论，更多内容需要在官方窗口登录后继续。':comments.length?'正在读取B站公开评论与回复。':'正在等待B站评论组件加载；已自动滚动至评论区。'};
  }
  const comments=[],batch=segment(cards);
  for(const card of batch.nodes){
    // A parent wrapper may also match; only read fields owned by this comment.
    const own=s=>s.split(',').map(part=>[...card.querySelectorAll(part)].find(e=>e.closest(selector)===card&&!e.querySelector(selector))).find(Boolean);
    const a=[...card.querySelectorAll('.author a[href],.user-info a[href],.reply-user-info a[href],.comment-item-info-wrap a[href],a#author-text,a.user-name[href],a.name[href],a.reply-user-name[href]')].find(a=>{try{const u=new URL(a.href);return a.closest(selector)===card&&u.protocol==='https:'&&!u.username&&!u.password&&(platform==='小红书'?['www.xiaohongshu.com','xiaohongshu.com'].includes(u.hostname)&&/^\/user\/profile\/[a-f\d]{24}/i.test(u.pathname):platform==='抖音'?u.hostname==='www.douyin.com'&&/^\/user\/[\w.-]+/.test(u.pathname):platform==='B站'?u.hostname==='space.bilibili.com'&&/^\/\d+/.test(u.pathname):platform==='YouTube'?u.hostname==='www.youtube.com'&&/^\/(?:channel\/UC[\w-]{22}|@[^/]+)/.test(u.pathname):false);}catch{return false;}});
    const douyinInfo=platform==='抖音'?own('.comment-item-info-wrap'):null;
    const douyinBody=douyinInfo?.nextElementSibling;
    const text=own(platform==='YouTube'?'#content-text':platform==='小红书'?'.content .note-text,.comment-content,.content':platform==='B站'?'.reply-content,.reply-content-container':'[data-e2e="comment-content"],.comment-content,.content')?.innerText?.trim()||(douyinBody?.closest(selector)===card?textOf(douyinBody):'');
    if(!text)continue;const u=a?new URL(a.href):null;
    const id=u?(platform==='YouTube'?u.pathname.slice(1).replace(/\/$/,''):u.pathname.split('/').filter(Boolean).at(-1)):null;
    let youtubeId='';if(platform==='YouTube')try{youtubeId=new URL(own('#published-time-text a[href]')?.href||'',location.href).searchParams.get('lc')||'';}catch{}
    const douyinId=platform==='抖音'?own('[data-e2e="video-comment-more"] [id^="tooltip_"]')?.id?.match(/^tooltip_(\d{1,24})$/)?.[1]:'';
    const douyinMeta=douyinBody?.nextElementSibling,douyinDate=douyinMeta?.closest(selector)===card?textOf(douyinMeta).split('·'):[];
    const commentId=card.dataset.commentId||card.getAttribute('data-rpid')||card.getAttribute('data-id')||youtubeId||douyinId||(card.id&&document.querySelectorAll('#'+CSS.escape(card.id)).length===1?card.id:'');
    comments.push({id:commentId,userId:id,name:(a?.innerText||own('.user-name,.name,.nickname,#author-text,.reply-user-name,.author,.user-info,.reply-user-info')?.innerText)?.trim().slice(0,200)||'匿名或用户资料未返回',text:text.slice(0,20000),avatar:own('img')?.src||'',published:own(platform==='小红书'?'.date span,.date':'.date,.time,.reply-time,#published-time-text')?.innerText?.trim()||douyinDate[0]?.trim()||'',region:own('.ip-location,.ip-tag,.date .location')?.innerText?.trim()||(douyinDate.length===2?douyinDate[1].trim():''),isReply:!!card.closest('.sub-comments,.sub-comment,.comment-item-sub,.replyContainer,.sub-reply-list,.sub-reply-item,#replies,ytd-comment-replies-renderer')});
  }
  if(batch.nextOffset)return {comments,nextOffset:batch.nextOffset,complete:false,blocked:needsLogin,reason:needsLogin?'login':undefined,message:needsLogin?'官方页面要求登录，已保留可见评论。':'正在分批读取页面已加载的评论。'};
  const root=document.querySelector(platform==='YouTube'?'#comments':platform==='小红书'?'.comments-container':platform==='B站'?'.reply-list':'[data-e2e="comment-list"],.comment-list');
  const replies=root?[...root.querySelectorAll('button,.show-more,.show-more-reply,.reply-more')].filter(visible).filter(e=>/展开.*回复|更多回复|查看.*回复|(?:view|show|more).*repl|^\d+\s+replies?$/i.test(textOf(e))||platform==='抖音'&&e.closest('.replyContainer')&&textOf(e)==='展开更多'):[];
  const end=root&&!replies.length&&[root,...root.querySelectorAll('*')].some(e=>visible(e)&&!e.closest(selector)&&!e.querySelector(selector)&&/^(?:THE END|没有更多评论|没有更多了|暂无评论|这是一片荒地)[。.!！\s]*$/i.test(textOf(e)));
  if(expand){for(const button of replies.slice(0,3))button.click();if(platform==='YouTube'&&root&&!cards.length)root.scrollIntoView?.({block:'start',behavior:'instant'});const candidates=platform==="小红书"?[document.querySelector(".note-scroller"),root]:[root];const scroller=candidates.find(e=>e&&e.scrollHeight>e.clientHeight+100&&/auto|scroll/.test(getComputedStyle(e).overflowY||''))||document.scrollingElement;if(scroller&&!(platform==='YouTube'&&root&&!cards.length))scroller.scrollTop+=Math.max(700,innerHeight*.8);}
  return {comments,complete:!!end&&!needsLogin,blocked:needsLogin,reason:needsLogin?(deviceLimit?'device-limit':'login'):undefined,message:deviceLimit?'小红书提示电脑设备登录超限，当前会话不可继续；请在官方窗口重新登录，已有评论保留。':needsLogin?(comments.length?'已保存当前可读取的公开评论；更多评论需要在官方窗口登录后继续。':'官方评论页面要求登录，请完成后继续。'):cards.length?'正在读取公开评论与评论者资料。':'官方页面暂未展示可识别的评论，请打开评论区后继续读取。'};
}
export function publicComment(platform,raw,known){
  if(!raw||typeof raw.text!=='string'||!raw.text.trim())return null;
  const user=searchUser(platform,{id:raw.userId,name:raw.name,avatar:raw.avatar});
  let key=String(raw.id||'')||createHash('sha256').update(JSON.stringify([platform,raw.userId,raw.text,raw.published,!!raw.isReply])).digest('hex');
  const name=typeof raw.name==='string'?raw.name.replace(/<[^>]*>/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').trim().slice(0,200):'';
  const displayName=user?.name||name||'用户资料未返回';
  // Keep the legacy key for the first row, including records from earlier versions.
  if(!raw.id&&!raw.userId&&known?.has(key)&&known.get(key).name!==displayName)
    key=createHash('sha256').update(JSON.stringify([key,displayName])).digest('hex');
  return {id:key,platform,userId:user?.id||null,name:displayName,profileURL:user?.url||null,avatar:user?.avatar||thumbnailUrl(raw.avatar),text:raw.text.slice(0,20000),published:String(raw.published||'').slice(0,100),region:String(raw.region||'').slice(0,100),isReply:!!raw.isReply};
}
export function wechatCommentPage(data,cursor=''){
  for(const key of ['BaseResponse','baseResponse','baseresponse'])for(const name of ['Ret','ret']){
    const ret=data?.[key]?.[name];
    if(ret!==undefined&&ret!==0&&ret!=='0')throw new Error('微信评论接口返回平台错误（'+String(ret).replace(/[^\w-]/g,'').slice(0,24)+'），已有资料和读取位置保留');
  }
  if(!Array.isArray(data?.commentInfo))throw new Error('微信未返回有效评论列表；资料保留，不能视为全部读取完成');
  const flag=data.downContinueFlag,explicitMore=Object.hasOwn(data,'downContinueFlag');
  if(explicitMore&&flag!==0&&flag!==false&&flag!==1&&flag!==true)throw new Error('微信评论分页状态无效，已有资料和读取位置保留');
  // The official FeedCommentList uses downContinueFlag for direction:2.
  // A terminal response may still contain a lastBuffer; it is not a next page.
  if(explicitMore&&(flag===0||flag===false))return {comments:data.commentInfo,next:'',explicitMore};
  const next=typeof data.lastBuffer==='string'?data.lastBuffer:null;
  if(next===null||(explicitMore&&!next.trim()))throw new Error('微信评论缺少有效分页状态，已有资料保留');
  if(next&&next===cursor)throw new Error('微信重复返回评论分页，已停止读取');
  return {comments:data.commentInfo,next,explicitMore};
}
function limitNotice(limit){
  return limit>=5000?'本次任务已达到 5000 条评论上限，可导出已读取的结果。':'已达到本次读取上限，可提高上限后继续。';
}
export class CommentWorkflow{
  constructor({store,search,accounts,wechat,connection,changed=()=>{}}){Object.assign(this,{store,search,accounts,wechat,connection,changed});this.browser=new ContentBrowser(accounts);this.browser.hidden=true;this.active=null;const last=store.get("meta","lastCommentCollection");this.record=last?store.get("comment-collection",last.id):null;if(this.record?.status==="reading")this.record.status="interrupted";}
  view(record=this.record){if(!record)return null;const {accountId,branches,replyTargets,pendingComments,domEnded,...r}=record;const users=new Map();for(const c of r.comments){if(!c.userId)continue;if(!users.has(c.userId))users.set(c.userId,{id:c.userId,name:c.name,url:c.profileURL,avatar:c.avatar,comments:[]});users.get(c.userId).comments.push(c);}const progress=this.active&&r.source.platform==='视频号'?this.connection?.status?.():null;return {...r,message:progress&&!['idle','connected'].includes(progress.phase)?progress.label:r.message,busy:!!this.active,users:[...users.values()],canContinue:r.status!=='complete'&&r.comments.length<5000};}
  publish(){this.record.updatedAt=Date.now();this.store.put('comment-collection',this.record.id,this.record);this.store.put('meta','lastCommentCollection',{id:this.record.id});this.store.flush();this.changed();}
  history(){
    return this.store.list('comment-collection').filter(r=>r?.id&&r.source).map(r=>({
      id:r.id, platform:r.source.platform, title:r.source.title, count:r.comments?.length||0, createdAt:r.createdAt
    })).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  }
  select(id){
    if(this.record?.id===id)return this.view();
    if(this.active)throw new Error('请先结束当前评论采集，再切换历史记录');
    const record=this.store.get('comment-collection',id);
    if(!record?.source||!Array.isArray(record.comments))throw new Error('评论记录不存在，请重新打开评论与私信');
    this.cancel();
    if(record.status==='reading')record.status='interrupted';
    this.record=record;
    this.store.put('meta','lastCommentCollection',{id});
    this.changed();
    return this.view();
  }
  show(){if(this.borrowedWindow&&!this.borrowedWindow.isDestroyed())this.borrowedWindow.show();else if(this.browser.window&&!this.browser.window.isDestroyed())this.browser.show();else throw new Error('当前没有打开的评论窗口。可查看原作品，或在未完成的采集记录中继续读取。');}
  cancel(){this.active?.abort();this.browser.close();this.borrowedWindow=null;}
  async close(){this.cancel();await this.pending?.catch(()=>{});}
  start(recordId,itemId,limit=50){if(this.active||this.search.active)throw new Error('正在读取作品或评论，请先停止当前操作');if(!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>5000)throw new Error('评论读取上限请输入 1–5000 的整数');const {item,accountId}=this.search.item(recordId,itemId);this.record={id:randomUUID(),source:item,accountId,comments:[],status:'reading',limit:Number(limit),message:'',createdAt:Date.now()};this.store.put('meta','lastCommentCollection',{id:this.record.id});return this.run(true);}
  more(id,limit){
    if(this.active||this.search.active)throw new Error('正在读取作品或评论，请先停止当前操作');
    if(!this.record||this.record.id!==id)throw new Error('评论任务已替换，请重新选择作品');
    const nextLimit=Number(limit===undefined?this.record.limit:limit);
    if(!Number.isInteger(nextLimit)||nextLimit<=this.record.comments.length||nextLimit>5000)
      throw new Error('请将读取上限提高到已取得评论数以上，最多 5000 条');
    this.record.limit=nextLimit;
    return this.run(false);
  }
  async run(initial){if(this.active||this.search.active)throw new Error('正在读取作品或评论，请先停止当前操作');const c=this.active=new AbortController();this.record.startedAt=Date.now();this.record.status="reading";
    try{this.publish();await(this.pending=(async()=>{const r=this.record;
      if(r.pendingComments?.length){
        const buffered=r.pendingComments.splice(0,r.limit-r.comments.length);
        r.comments.push(...buffered);
        const ended=r.domEnded||(r.source.platform==='视频号'&&r.branches?.length===0);
        if(ended&&!r.pendingComments.length){
          r.status='complete';r.message='已显示保存的全部评论，已读至平台返回的末页。';
          this.publish();return;
        }
        if(r.comments.length>=r.limit){
          r.status='limited';r.message=limitNotice(r.limit);
          this.publish();return;
        }
        this.publish();
      }
      if(r.source.platform==='视频号')return this.connection.withConnection(c.signal,async()=>{
        let oid=String(r.source.sourceId||r.source.id||''),nid=r.source.objectNonceId||'';
        if(!/^\d{1,24}$/.test(oid)||!nid){r.message='正在从所选原作品确认评论所需标识';this.publish();const data=await this.wechat.request('/api/channels/feed/profile',{url:r.source.url},c.signal);const object=data.object;if(!object||!/^\d{1,24}$/.test(String(object.id||''))||!object.objectNonceId)throw Error('原作品未返回评论所需的完整标识，请确认视频仍可访问后继续');oid=String(object.id);nid=object.objectNonceId;}
        r.branches ||= [{id:'',cursor:''}];r.replyTargets ||= [];r.pendingComments ||= [];
        const drain=()=>{while(r.pendingComments.length&&r.comments.length<r.limit){const row=r.pendingComments.shift();if(!r.comments.some(v=>v.id===row.id))r.comments.push(row);}};drain();
        const known=new Map(r.comments.map(row=>[row.id,row]));
        const merge=(comment,isReply=false)=>{
          const row=publicComment('视频号',{id:String(comment.commentId||''),userId:comment.username,name:comment.nickname,text:comment.content,avatar:comment.headUrl,published:comment.createtime,isReply},known);
          if(row&&!known.has(row.id)){known.set(row.id,row);r.pendingComments.push(row);}
          for(const child of comment.levelTwoComment||[])merge(child,true);
          if(!isReply&&comment.commentId&&Number(comment.expandCommentCount)>0&&!r.replyTargets.includes(String(comment.commentId))){r.replyTargets.push(String(comment.commentId));r.branches.push({id:String(comment.commentId),cursor:''});}
        };
        let emptyPages=0;const cursors=new Map();
        for(let p=0;p<50&&r.branches.length&&r.comments.length<r.limit;p++){
          c.signal.throwIfAborted();r.message=r.comments.length?'正在继续读取评论和回复':'评论接口已就绪，正在读取首批评论';this.publish();const branch=r.branches[0],data=await this.wechat.request('/api/channels/feed/comment/list',{oid,nid,comment_id:branch.id,next_marker:encodeURIComponent(branch.cursor)},c.signal);
          c.signal.throwIfAborted();const page=wechatCommentPage(data,branch.cursor),next=page.next;
          if(!cursors.has(branch.id))cursors.set(branch.id,new Set([branch.cursor]));const seen=cursors.get(branch.id);
          if(next&&seen.has(next))throw new Error('微信重复返回评论分页，已停止读取');if(next)seen.add(next);
          const before=r.comments.length+r.pendingComments.length;for(const comment of page.comments)merge(comment,!!branch.id);drain();
          if(next)branch.cursor=next;else r.branches.shift();
          this.publish();
          if(r.comments.length>=r.limit){r.status='limited';r.message=limitNotice(r.limit);break;}
          if(next&&r.comments.length+r.pendingComments.length===before){
            if(!page.explicitMore)throw new Error('微信评论未返回新条目，保留当前读取位置');
            if(++emptyPages>=3)throw new Error('微信连续 3 页未返回新评论，已保留真实分页位置和资料，可稍后继续读取');
          }else emptyPages=0;
        }
        if(!r.branches.length&&!r.pendingComments.length){r.status='complete';r.message='已读取至平台返回的评论与回复末页，仅包含公开可访问资料。';}else if(r.comments.length>=r.limit){r.status='limited';r.message=limitNotice(r.limit);}else if(r.status!=='limited'){r.status='interrupted';r.message='本批评论已保存，可继续读取。';}
        this.publish();
      },['comments',...(!/^\d{1,24}$/.test(String(r.source.sourceId||r.source.id||''))||!r.source.objectNonceId?['detail']:[])]);
      let borrowed=null;
      if(r.source.platform==='抖音'&&this.accounts.usesExternal?.(r.source.platform,r.accountId)){
        if((this.accounts.active(r.source.platform)?.id||null)!==r.accountId)throw Error('评论读取账号已切换，请重新读取');
        const candidates=[this.borrowedWindow?{window:this.borrowedWindow,accountId:this.borrowedAccountId}:null,this.search.browser,this.search.creators?.browser,this.search.userSearch?.browser];
        const sourceBrowser=candidates.find(b=>{try{return b?.window?.externalTab&&(b.accountId||null)===(r.accountId||null)&&!b.window.isDestroyed()&&new URL(b.window.webContents.getURL()).hostname==='www.douyin.com';}catch{return false;}});
        borrowed=await this.browser.selectDouyinWork(r.source,c.signal,{sourceBrowser});this.borrowedWindow=borrowed;
        this.borrowedAccountId=r.accountId;
      }else {this.borrowedWindow=null;if(initial||!this.browser.window||this.browser.window.isDestroyed())await this.browser.open(r.source.url,{id:r.id,platform:r.source.platform,accountId:r.accountId,detailId:r.source.id},c.signal);}
      if(!initial&&r.source.platform==='YouTube'){
        if((this.accounts.active(r.source.platform)?.id||null)!==r.accountId)throw Error('评论读取账号已切换，请重新读取');
        const current=this.browser.window.webContents.getURL?.();
        if(current&&youtubeCommentContext(current,r.source.url).action==='restore')await this.browser.open(r.source.url,{id:r.id,platform:r.source.platform,accountId:r.accountId,detailId:r.source.id},c.signal,{reuse:true});
      }
      c.signal.throwIfAborted();let w=borrowed||this.browser.window;w.hide();let stagnant=0,serviceRetried=false,emptyRetried=false,offset=0;
      for(let i=0;i<40;i++){
        c.signal.throwIfAborted();if((this.accounts.active(r.source.platform)?.id||null)!==r.accountId)throw new Error('评论读取账号已切换，请重新读取');if(w.isDestroyed())throw new Error('官方评论窗口已关闭');
        if(r.source.platform==='抖音'){
          const state=await w.webContents.executeJavaScript(`(${douyinPageState.toString()})()`);
          if(state.retryable){if(borrowed)throw Object.assign(Error(state.message),{needsAction:true});if(serviceRetried)throw Error('抖音官方页面仍未返回内容；本次已自动重连，已有评论和位置保留。');serviceRetried=true;r.message=state.message;this.publish();await this.browser.open(r.source.url,{id:r.id,platform:r.source.platform,accountId:r.accountId,detailId:r.source.id},c.signal,{reuse:true});w=this.browser.window;continue;}
        }
        const page=await w.webContents.executeJavaScript(`(()=>{try{return (${renderedComments.toString()})(${JSON.stringify(r.source.platform)},${JSON.stringify(r.source.url)},true,${offset});}catch(e){return {scriptError:String(e.name||'Error')+': '+String(e.message||'读取异常')};}})()`);
        if(page?.scriptError)throw new Error('评论页面读取异常：'+page.scriptError.slice(0,300)+'；已有资料保留，可继续读取。');
        c.signal.throwIfAborted();
        const map=new Map([...r.comments,...(r.pendingComments||[])].map(v=>[v.id,v])),before=map.size;
        let changed=page.message!==r.message;
        for(const raw of page.comments){
          const row=publicComment(r.source.platform,raw,map);
          if(row&&JSON.stringify(map.get(row.id))!==JSON.stringify(row)){map.set(row.id,row);changed=true;}
        }
        const rows=[...map.values()];r.comments=rows.slice(0,r.limit);r.pendingComments=rows.slice(r.limit);
        if(page.complete&&!page.blocked&&r.pendingComments.length){r.domEnded=true;changed=true;}
        r.message=page.message;
        if(changed)this.publish();
        if(page.blocked){if(page.reason==='login'&&!r.comments.length&&i<3){r.message='页面提示登录，正在确认是否仍有可公开读取的首批评论';this.publish();await delay(1000,undefined,{signal:c.signal});continue;}r.status='needs-action';this.show();break;}if(page.complete&&map.size<=r.limit){r.status='complete';r.message='已读取至页面返回的评论末尾；仅包含平台公开可访问资料。';break;}if(r.comments.length>=r.limit){r.status='limited';r.message=limitNotice(r.limit);break;}
        offset=page.nextOffset||0;
        if(offset)continue;
        if(r.source.platform==='YouTube'&&!map.size&&stagnant>=14&&!emptyRetried){
          emptyRetried=true;stagnant=0;r.message='YouTube 首批评论暂未返回，正在同一 Chrome 会话重新加载所选视频一次';this.publish();
          await this.browser.open(r.source.url,{id:r.id,platform:r.source.platform,accountId:r.accountId,detailId:r.source.id},c.signal,{reuse:true});w=this.browser.window;continue;
        }
        stagnant=map.size===before?stagnant+1:0;if(stagnant>=(r.comments.length?8:15)){r.status='interrupted';r.message='页面暂未返回新评论，已保留资料；展开评论区后可以继续，不视为全部完成。';break;}
        await delay(1000,undefined,{signal:c.signal});
      }
      if(r.status==='reading'){r.status='interrupted';r.message='本批已保存，可继续读取后续评论。';}this.publish();})());}
    catch(e){if(/Script failed to execute|Execution context was destroyed/i.test(e.message))e=new Error('官方评论页面正在更新或跳转，读取暂时中断；已有资料和位置保留，可继续读取。');if(this.record){this.record.status=!c.signal.aborted&&e.needsAction?'needs-action':'interrupted';this.record.message=c.signal.aborted?'已停止，已有评论资料保留，可继续读取。':e.message;this.publish();}throw e;}
    finally{this.active=null;this.pending=null;this.changed();}
    return this.view();
  }
}
