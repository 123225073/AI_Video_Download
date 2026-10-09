import {createHash} from 'node:crypto';
import {clipboard} from 'electron';
import {ContentBrowser} from './content-browser.js';
import {setTimeout as delay} from 'node:timers/promises';
import {contactHash,contactText} from './contact-data.js';
// Shared preparation/submit validation runs inside the official renderer.
export function renderedContactEditor(data,submit=false){
  const target=new URL(data.profileURL);
  const selector='[role=dialog],.chat-dialog,.message-dialog,.chat-container,[data-user-id]';
  const visible=e=>e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const text=e=>String(e?.innerText??e?.textContent??'').trim();
  const label=input=>(input.placeholder||'')+' '+(input.getAttribute('data-placeholder')||'')+' '+(input.getAttribute('aria-label')||'');
  const identity=e=>{const id=e.getAttribute('data-user-id');if(id)return id===data.userId;return [...e.querySelectorAll('header a[href],[class*=header] a[href],[class*=recipient] a[href]')].some(a=>{try{const u=new URL(a.href);return a.closest(selector)===e&&u.hostname===target.hostname&&u.pathname===target.pathname;}catch{return false;}});};
  const validInput=(input,scope)=>input.closest(selector)===scope&&visible(input)&&!input.closest('.comments-container,.comment-list,[data-e2e="comment-list"]')&&!/搜索|search/i.test(label(input))&&(/消息|私信|message/i.test(label(input))||scope.matches('.chat-dialog,.message-dialog,.chat-container')&&/说点什么/.test(label(input)));
  const field=e=>[...e.querySelectorAll('textarea,[contenteditable=true],input[type=text]')].find(input=>validInput(input,e)&&(!submit||input.getAttribute('data-fengsha-contact-input')===data.id));
  const scope=[...document.querySelectorAll(selector)].find(e=>visible(e)&&identity(e)&&(!submit||e.getAttribute('data-fengsha-contact')===data.id)&&field(e));
  const no=()=>submit?{submitted:false}:false;if(!scope)return no();const input=field(scope);
  if(!submit){if(input.isContentEditable){input.textContent=data.text;input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:data.text}));}else{Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set?.call(input,data.text);input.dispatchEvent(new Event('input',{bubbles:true}));}scope.setAttribute('data-fengsha-contact',data.id);input.setAttribute('data-fengsha-contact-input',data.id);return true;}
  const normalize=v=>String(v||'').replace(/\r\n?/g,'\n').trim();const actual=input.isContentEditable?[input.textContent,input.innerText]:[input.value];if(!actual.some(v=>normalize(v)===normalize(data.text)))return no();
  const button=[...scope.querySelectorAll('button')].find(e=>e.closest(selector)===scope&&visible(e)&&!e.disabled&&typeof e.click==='function'&&/^(发送|Send)$/.test(text(e)));if(!button)return no();button.click();return {submitted:true};
}
export class ContactMessages{
  constructor({store,comments,accounts,changed=()=>{}}){Object.assign(this,{store,comments,accounts,changed});this.browser=new ContentBrowser(accounts);this.prepared=null;this.active=null;const last=store.get('meta','lastContactBatch');this.batch=last?store.get('contact-batch',last.id):null;if(this.batch?.status==='running')this.batch.status='interrupted';if(this.batch)for(const row of this.batch.rows){if(row.status==='preparing')row.status=['uncertain','submitted'].includes(store.get('contact-message',row.hash)?.status)?'uncertain':'pending';}}
  async run(fn){if(this.active)throw new Error('正在准备或发送私信，请等待完成');const controller=this.active=new AbortController();this.changed();try{return await(this.pending=fn(controller.signal));}finally{this.active=null;this.pending=null;this.changed();}}
  cancel(){this.active?.abort();}
  async close(){this.cancel();await this.pending?.catch(()=>{});this.browser.close();this.prepared=null;}
  prepare(collectionId,userId,accountId,template){return this.run(signal=>this.prepareOne(collectionId,userId,accountId,template,signal));}
  async prepareOne(collectionId,userId,accountId,template,signal,rendered=false){
    const r=this.comments.record?.id===collectionId?this.comments.record:this.store.get('comment-collection',collectionId);
    const comment=r?.comments.find(c=>c.userId===userId&&c.profileURL),account=this.accounts.list().find(a=>a.id===accountId&&a.platform===r?.source.platform);
    if(!comment||!account)throw new Error('请选择有稳定主页的评论者和同平台联系账号');
    const text=contactText(template,comment,r.source,rendered);
    const hash=contactHash(r.source.platform,userId,accountId,text);const previous=this.store.get('contact-message',hash);
    if(previous?.status==='submitted'||previous?.status==='uncertain')throw new Error('这条文案已尝试发送给该用户，请先核对官方聊天记录，避免重复');
    clipboard.writeText(text);
    const w=await this.browser.open(comment.profileURL,{id:'contact-'+userId,platform:r.source.platform,accountId},signal);
    await delay(1200,undefined,{signal});const opened=await w.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button,a')].find(e=>e.getClientRects().length&&typeof e.click==='function'&&/^(私信|发消息|发送消息|Message)$/.test(String(e.innerText??e.textContent??'').trim()));if(button){button.click();return true;}return false;})()`);signal.throwIfAborted();
    this.prepared={id:hash,collectionId,userId,accountId,platform:r.source.platform,name:comment.name,profileURL:comment.profileURL,text,status:'prepared',opened,createdAt:Date.now()};this.store.put('contact-message',hash,this.prepared);this.store.flush();
    return {...this.prepared,message:opened?'已打开官方私信入口，文案已复制；请核对接收者并在发送前预览。':'该官方主页未展示网页私信入口，文案已复制，可在平台客户端完成联系。'};
  }
  viewBatch(){return this.batch?{...structuredClone(this.batch),busy:!!this.active&&this.batch.status==='running'}:null;}
  saveBatch(){this.batch.updatedAt=Date.now();this.store.put('contact-batch',this.batch.id,this.batch);this.store.put('meta','lastContactBatch',{id:this.batch.id});this.store.flush();this.changed();}
  previewBatch(collectionId,userIds,accountId,template,interval=5){
    if(this.active)throw new Error('当前私信任务正在执行，请先停止');
    if(!Array.isArray(userIds)||!userIds.length||userIds.length>5000||userIds.some(id=>typeof id!=='string')||new Set(userIds).size!==userIds.length)throw new Error('请选择有效且不重复的用户');
    if(!Number.isFinite(Number(interval))||Number(interval)<3||Number(interval)>60)throw new Error('私信间隔请输入3–60秒');
    const r=this.comments.record?.id===collectionId?this.comments.record:this.store.get('comment-collection',collectionId);
    if(!r||!this.accounts.list().some(a=>a.id===accountId&&a.platform===r.source.platform))throw new Error('请选择同平台联系账号');
    const rows=userIds.map(userId=>{const c=r.comments.find(c=>c.userId===userId&&c.profileURL);if(!c)throw new Error('所选用户缺少稳定身份或主页，不能发送');const text=contactText(template,c,r.source),hash=contactHash(r.source.platform,userId,accountId,text),prior=this.store.get('contact-message',hash);return {userId,name:c.name,text,hash,status:['submitted','uncertain'].includes(prior?.status)?'already-attempted':'pending'};});
    this.batch={id:'batch-'+Date.now()+'-'+Math.random().toString(36).slice(2),collectionId,accountId,platform:r.source.platform,interval:Number(interval),rows,status:'ready',createdAt:Date.now()};this.saveBatch();return this.viewBatch();
  }
  sendBatch(id){return this.run(async signal=>{
    const b=this.batch;if(!b||b.id!==id||!['ready','interrupted','stopped'].includes(b.status))throw new Error('请先预览本次选中的用户与文案');
    for(const row of b.rows)if(row.status==='blocked')row.status=['submitted','uncertain'].includes(this.store.get('contact-message',row.hash)?.status)?'uncertain':'pending';
    if(!b.rows.some(r=>r.status==='pending'))throw new Error('当前批次没有待发送用户；已经尝试的条目不会重发');
    b.status='running';b.startedAt=Date.now();this.saveBatch();this.browser.hidden=true;
    try{for(const row of b.rows){if(row.status!=='pending')continue;signal.throwIfAborted();row.status='preparing';this.saveBatch();
      try{const p=await this.prepareOne(b.collectionId,row.userId,b.accountId,row.text,signal,true);if(!p.opened)throw new Error('该用户没有网页私信入口，请在平台客户端联系');
        const result=await this.sendOne(p.id,signal);row.status=result.status;row.message=result.message;this.saveBatch();
      }catch(e){row.status=this.prepared?.id===row.hash&&this.prepared.status==='uncertain'?'uncertain':'blocked';row.message=e.message;b.status=signal.aborted?'stopped':'interrupted';this.saveBatch();if(!signal.aborted)this.browser.show();return this.viewBatch();}
      if(b.rows.some(r=>r.status==='pending'))await delay(b.interval*1000,undefined,{signal});
    }b.status='completed';this.saveBatch();return this.viewBatch();
    }catch(e){if(signal.aborted){b.status='stopped';this.saveBatch();return this.viewBatch();}b.status='interrupted';this.saveBatch();throw e;}
    finally{this.browser.hidden=false;}
  }).then(()=>this.viewBatch());}
  send(id){return this.run(signal=>this.sendOne(id,signal));}
  async sendOne(id,signal){const p=this.prepared,w=this.browser.window;if(!p||p.id!==id||!w||w.isDestroyed())throw new Error('请先准备并预览这一位用户的联系文案');if(p.status!=='prepared')throw new Error('本条已尝试发送，请核对官方记录，不会自动重复发送');
    if(!p.opened)throw new Error('当前官方页面没有可自动填写的私信入口，请在平台客户端完成');
    signal.throwIfAborted();
    const ready=await w.webContents.executeJavaScript(`(${renderedContactEditor.toString()})(${JSON.stringify(p)},false)`);
    if(!ready)throw new Error('未能核对官方聊天窗口的接收者或输入框，请在官方客户端完成联系');
    await delay(500,undefined,{signal});signal.throwIfAborted();
    // Persist an uncertain attempt before clicking; a lost page response must not
    // cause a retry that sends the same message twice.
    this.prepared={...p,status:'uncertain',attemptedAt:Date.now()};this.store.put('contact-message',p.id,this.prepared);this.store.flush();
    const result=await w.webContents.executeJavaScript(`(${renderedContactEditor.toString()})(${JSON.stringify(p)},true)`);
    if(!result.submitted){this.prepared=p;this.store.put('contact-message',p.id,p);this.store.flush();throw new Error('官方聊天接收者、文案或发送按钮发生变化，请重新核对后准备');}
    this.prepared={...p,status:'uncertain',attemptedAt:Date.now()};this.store.put('contact-message',p.id,this.prepared);this.store.flush();return {...this.prepared,message:'已点击官方发送按钮，送达状态尚未确认；请核对聊天记录，不会自动重试。'};
  }
}
