import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {searchUser} from './user-search-data.js';
import {ContentBrowser} from './content-browser.js';
export function renderedComments(platform,sourceURL,expand=false){
  const source=new URL(sourceURL),here=new URL(location.href);
  if(here.hostname!==source.hostname||here.pathname!==source.pathname||platform==='YouTube'&&here.searchParams.get('v')!==source.searchParams.get('v'))return {blocked:true,message:'评论窗口已离开所选作品，请重新打开。',comments:[]};
  const visible=e=>e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const selectors={ '小红书':'.comments-container .comment-item,.comments-container .parent-comment,.comments-container .sub-comment','抖音':'[data-e2e="comment-list"] [data-e2e="comment-item"],[data-e2e="comment-item"]','B站':'.reply-list .root-reply,.reply-list .reply-item,.reply-list .sub-reply-item',YouTube:'#comments ytd-comment-view-model,#comments ytd-comment-renderer','视频号':'.comment-list .comment-item' };
  const cards=[...document.querySelectorAll(selectors[platform]||'.no-supported-comment')].filter(visible);
  if(!cards.length&&(/验证码|安全限制|unusual traffic/i.test(document.title)||[...document.querySelectorAll('.login-modal,[data-e2e="login-dialog"],[class*="captcha"]')].some(visible)))return {blocked:true,message:'官方评论页面要求登录或验证，请完成后继续。',comments:[]};
  const comments=[];
  for(const card of cards.slice(0,2000)){
    const a=[...card.querySelectorAll('.author a[href],.user-info a[href],.reply-user-info a[href],a#author-text,a.user-name[href],a.name[href],a.reply-user-name[href]')].find(a=>{try{const u=new URL(a.href);return u.protocol==='https:'&&!u.username&&!u.password&&(platform==='小红书'?['www.xiaohongshu.com','xiaohongshu.com'].includes(u.hostname)&&/^\/user\/profile\/[a-f\d]{24}/i.test(u.pathname):platform==='抖音'?u.hostname==='www.douyin.com'&&/^\/user\/[\w.-]+/.test(u.pathname):platform==='B站'?u.hostname==='space.bilibili.com'&&/^\/\d+/.test(u.pathname):platform==='YouTube'?u.hostname==='www.youtube.com'&&/^\/(?:channel\/UC[\w-]{22}|@[^/]+)/.test(u.pathname):false);}catch{return false;}});
    const text=card.querySelector(platform==='YouTube'?'#content-text':platform==='小红书'?'.content .note-text,.comment-content,.content':platform==='B站'?'.reply-content,.reply-content-container':'[data-e2e="comment-content"],.comment-content,.content')?.innerText?.trim();
    if(!text)continue;const u=a?new URL(a.href):null;
    const id=u?(platform==='YouTube'?u.pathname.slice(1).replace(/\/$/,''):u.pathname.split('/').filter(Boolean).at(-1)):null;
    const commentId=card.dataset.commentId||card.getAttribute('data-rpid')||card.getAttribute('data-id')||(card.id&&document.querySelectorAll('#'+CSS.escape(card.id)).length===1?card.id:'');
    comments.push({id:commentId,userId:id,name:a?.innerText?.trim().slice(0,200)||'匿名或用户资料未返回',text:text.slice(0,20000),avatar:card.querySelector('img')?.src||'',published:card.querySelector('.date,.time,.reply-time,#published-time-text')?.innerText?.trim()||'',region:card.querySelector('.ip-location,.ip-tag')?.innerText?.trim()||'',isReply:!!card.closest('.sub-comments,.sub-comment,.sub-reply-list,#replies')});
  }
  const root=document.querySelector(platform==='YouTube'?'#comments':platform==='小红书'?'.comments-container':platform==='B站'?'.reply-list':'[data-e2e="comment-list"],.comment-list');
  const end=root&&(/THE END|没有更多评论|没有更多了|暂无评论|这是一片荒地/i.test(root.innerText));
  if(expand&&root){for(const button of [...root.querySelectorAll('button,.show-more,.show-more-reply')].filter(visible).filter(e=>/展开.*回复|更多回复|查看.*回复|replies/i.test(e.innerText)).slice(0,3))button.click();const candidates=platform==="小红书"?[document.querySelector(".note-scroller"),root]:[root];const scroller=candidates.find(e=>e&&e.scrollHeight>e.clientHeight+100)||document.scrollingElement;scroller.scrollTop+=Math.max(700,innerHeight*.8);}
  return {comments,complete:!!end,message:cards.length?'正在读取公开评论与评论者资料。':'官方页面暂未展示可识别的评论，请打开评论区后继续读取。'};
}
export function publicComment(platform,raw){
  if(!raw||typeof raw.text!=='string'||!raw.text.trim())return null;
  const user=searchUser(platform,{id:raw.userId,name:raw.name,avatar:raw.avatar});
  const key=String(raw.id||'')||createHash('sha256').update(JSON.stringify([platform,raw.userId,raw.text,raw.published,!!raw.isReply])).digest('hex');
  return {id:key,platform,userId:user?.id||null,name:user?.name||'用户资料未返回',profileURL:user?.url||null,avatar:user?.avatar||'',text:raw.text.slice(0,20000),published:String(raw.published||'').slice(0,100),region:String(raw.region||'').slice(0,100),isReply:!!raw.isReply};
}
export class CommentWorkflow{
  constructor({store,search,accounts,wechat,connection,changed=()=>{}}){Object.assign(this,{store,search,accounts,wechat,connection,changed});this.browser=new ContentBrowser(accounts);this.active=null;const last=store.get("meta","lastCommentCollection");this.record=last?store.get("comment-collection",last.id):null;if(this.record?.status==="reading")this.record.status="interrupted";}
  view(){if(!this.record)return null;const {accountId,branches,replyTargets,pendingComments,...r}=this.record;const users=new Map();for(const c of r.comments){if(!c.userId)continue;if(!users.has(c.userId))users.set(c.userId,{id:c.userId,name:c.name,url:c.profileURL,avatar:c.avatar,comments:[]});users.get(c.userId).comments.push(c);}return {...r,busy:!!this.active,users:[...users.values()],canContinue:!['complete','cancelled'].includes(r.status)};}
  cancel(){this.active?.abort();this.browser.close();}
  async close(){this.cancel();await this.pending?.catch(()=>{});}
  start(recordId,itemId,limit=50){if(this.active)throw new Error('评论采集正在运行，请先停止');if(!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>5000)throw new Error('评论读取上限请输入 1–5000，超过上限可继续分批读取');const {item,accountId}=this.search.item(recordId,itemId);this.record={id:randomUUID(),source:item,accountId,comments:[],status:'reading',limit:Number(limit),message:'',createdAt:Date.now()};this.store.put('meta','lastCommentCollection',{id:this.record.id});return this.run(true);}
  more(id,limit){if(!this.record||this.record.id!==id)throw new Error('评论任务已替换，请重新选择作品');if(limit!==undefined){if(!Number.isInteger(Number(limit))||Number(limit)<this.record.comments.length||Number(limit)>5000)throw new Error('请增加有效的评论上限');this.record.limit=Number(limit);}return this.run(false);}
  async run(initial){if(this.active||this.search.active)throw new Error('正在读取作品或评论，请先停止当前操作');const c=this.active=new AbortController();this.record.status="reading";this.changed();
    try{return await(this.pending=(async()=>{const r=this.record;
      if(r.source.platform==='视频号')return this.connection.withConnection(c.signal,async()=>{
        r.branches ||= [{id:'',cursor:''}];r.replyTargets ||= [];r.pendingComments ||= [];
        const drain=()=>{while(r.pendingComments.length&&r.comments.length<r.limit){const row=r.pendingComments.shift();if(!r.comments.some(v=>v.id===row.id))r.comments.push(row);}};drain();
        const merge=(comment,isReply=false)=>{const row=publicComment('视频号',{id:String(comment.commentId||''),userId:comment.username,name:comment.nickname,text:comment.content,avatar:comment.headUrl,published:comment.createtime,isReply});if(row&&!r.comments.some(v=>v.id===row.id)&&!r.pendingComments.some(v=>v.id===row.id))r.pendingComments.push(row);for(const child of comment.levelTwoComment||[])merge(child,true);if(!isReply&&Number(comment.expandCommentCount)>0&&!r.replyTargets.includes(String(comment.commentId))){r.replyTargets.push(String(comment.commentId));r.branches.push({id:String(comment.commentId),cursor:''});}};
        for(let p=0;p<50&&r.branches.length&&r.comments.length<r.limit;p++){
          c.signal.throwIfAborted();const branch=r.branches[0],data=await this.wechat.request('/api/channels/feed/comment/list',{oid:r.source.id,nid:r.source.objectNonceId||'',comment_id:branch.id,next_marker:encodeURIComponent(branch.cursor)},c.signal);
          if(!Array.isArray(data.commentInfo))throw new Error('微信未返回有效评论列表；资料保留，不能视为全部读取完成');
          const before=r.comments.length;for(const comment of data.commentInfo)merge(comment,!!branch.id);drain();
          const next=typeof data.lastBuffer==='string'?data.lastBuffer:null;if(next===null)throw new Error('微信评论缺少分页状态，已有资料保留');if(next&&next===branch.cursor)throw new Error('微信重复返回评论分页，已停止读取');
          if(next)branch.cursor=next;else r.branches.shift();
          this.store.put('comment-collection',r.id,r);this.changed();
          if(r.comments.length>=r.limit){r.status='limited';r.message='已达到本次评论上限，可提高后继续读取。';break;}
          if(next&&r.comments.length===before)throw new Error('微信评论未返回新条目，保留当前读取位置');
        }
        if(!r.branches.length&&!r.pendingComments.length){r.status='complete';r.message='已读取至平台返回的评论与回复末页，仅包含公开可访问资料。';}else if(r.comments.length>=r.limit){r.status='limited';r.message='已达到本次评论上限，可提高后继续读取。';}else if(r.status!=='limited'){r.status='interrupted';r.message='本批评论已保存，可继续读取。';}
        this.store.put('comment-collection',r.id,r);this.store.flush();return this.view();
      });
      if(initial||!this.browser.window||this.browser.window.isDestroyed())await this.browser.open(r.source.url,{id:r.id,platform:r.source.platform,accountId:r.accountId,detailId:r.source.id},c.signal);
      const w=this.browser.window;let stagnant=0;
      for(let i=0;i<40;i++){
        c.signal.throwIfAborted();if((this.accounts.active(r.source.platform)?.id||null)!==r.accountId)throw new Error('评论读取账号已切换，请重新读取');if(w.isDestroyed())throw new Error('官方评论窗口已关闭');
        const page=await w.webContents.executeJavaScript(`(${renderedComments.toString()})(${JSON.stringify(r.source.platform)},${JSON.stringify(r.source.url)},true)`);
        const map=new Map(r.comments.map(v=>[v.id,v])),before=map.size;for(const raw of page.comments){const row=publicComment(r.source.platform,raw);if(row)map.set(row.id,row);}r.comments=[...map.values()].slice(0,r.limit);r.message=page.message;this.store.put('comment-collection',r.id,r);this.changed();
        if(page.blocked){r.status='needs-action';break;}if(page.complete&&map.size<=r.limit){r.status='complete';r.message='已读取至页面返回的评论末尾；仅包含平台公开可访问资料。';break;}if(r.comments.length>=r.limit){r.status='limited';r.message='已达到本次读取上限；可提高上限后继续，已有评论会去重。';break;}
        stagnant=map.size===before?stagnant+1:0;if(stagnant>=8){r.status='interrupted';r.message='页面暂未返回新评论，已保留资料；展开评论区后可以继续，不视为全部完成。';break;}
        await delay(1000,undefined,{signal:c.signal});
      }
      if(r.status==='reading')r.status='interrupted';this.store.put('comment-collection',r.id,r);this.store.flush();return this.view();})());}
    catch(e){if(this.record){this.record.status=c.signal.aborted?'cancelled':'interrupted';this.record.message=e.message;this.store.put('comment-collection',this.record.id,this.record);this.store.flush();}throw e;}
    finally{this.active=null;this.pending=null;this.changed();}
  }
}
