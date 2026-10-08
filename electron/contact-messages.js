import {createHash} from 'node:crypto';
import {clipboard} from 'electron';
import {ContentBrowser} from './content-browser.js';
import {setTimeout as delay} from 'node:timers/promises';
export class ContactMessages{
  constructor({store,comments,accounts,changed=()=>{}}){Object.assign(this,{store,comments,accounts,changed});this.browser=new ContentBrowser(accounts);this.prepared=null;this.active=null;}
  async run(fn){if(this.active)throw new Error('正在准备或发送私信，请等待完成');const controller=this.active=new AbortController();this.changed();try{return await(this.pending=fn(controller.signal));}finally{this.active=null;this.pending=null;this.changed();}}
  cancel(){this.active?.abort();}
  async close(){this.cancel();await this.pending?.catch(()=>{});this.browser.close();this.prepared=null;}
  prepare(collectionId,userId,accountId,template){return this.run(signal=>this.prepareOne(collectionId,userId,accountId,template,signal));}
  async prepareOne(collectionId,userId,accountId,template,signal){
    const r=this.comments.record?.id===collectionId?this.comments.record:this.store.get('comment-collection',collectionId);
    const comment=r?.comments.find(c=>c.userId===userId&&c.profileURL),account=this.accounts.list().find(a=>a.id===accountId&&a.platform===r?.source.platform);
    if(!comment||!account)throw new Error('请选择有稳定主页的评论者和同平台联系账号');
    if(typeof template!=='string'||!template.trim()||template.length>2000)throw new Error('请输入 1–2000 字的联系文案');
    const text=template.replaceAll('{昵称}',comment.name).replaceAll('{评论}',comment.text.slice(0,300)).replaceAll('{作品}',r.source.title);
    const hash=createHash('sha256').update([r.source.platform,userId,accountId,text].join('\n')).digest('hex');const previous=this.store.get('contact-message',hash);
    if(previous?.status==='submitted'||previous?.status==='uncertain')throw new Error('这条文案已尝试发送给该用户，请先核对官方聊天记录，避免重复');
    clipboard.writeText(text);
    const w=await this.browser.open(comment.profileURL,{id:'contact-'+userId,platform:r.source.platform,accountId},signal);
    await delay(1200,undefined,{signal});const opened=await w.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button,a')].find(e=>e.getClientRects().length&&/^(私信|发消息|发送消息|Message)$/.test(e.innerText.trim()));if(button){button.click();return true;}return false;})()`);signal.throwIfAborted();
    this.prepared={id:hash,collectionId,userId,accountId,platform:r.source.platform,name:comment.name,profileURL:comment.profileURL,text,status:'prepared',opened,createdAt:Date.now()};this.store.put('contact-message',hash,this.prepared);this.store.flush();
    return {...this.prepared,message:opened?'已打开官方私信入口，文案已复制；请核对接收者并在发送前预览。':'该官方主页未展示网页私信入口，文案已复制，可在平台客户端完成联系。'};
  }
  send(id){return this.run(signal=>this.sendOne(id,signal));}
  async sendOne(id,signal){const p=this.prepared,w=this.browser.window;if(!p||p.id!==id||!w||w.isDestroyed())throw new Error('请先准备并预览这一位用户的联系文案');if(p.status!=='prepared')throw new Error('本条已尝试发送，请核对官方记录，不会自动重复发送');
    if(!p.opened)throw new Error('当前官方页面没有可自动填写的私信入口，请在平台客户端完成');
    signal.throwIfAborted();
    const ready=await w.webContents.executeJavaScript(`(data=>{const target=new URL(data.profileURL);const scope=[...document.querySelectorAll('[role=dialog],.chat-dialog,.message-dialog,.chat-container,[data-user-id]')].find(e=>e.getAttribute('data-user-id')===data.userId||[...e.querySelectorAll('a[href]')].some(a=>{try{const u=new URL(a.href);return u.hostname===target.hostname&&u.pathname===target.pathname;}catch{return false;}}));if(!scope)return false;const input=[...scope.querySelectorAll('textarea,[contenteditable=true],input[type=text]')].find(e=>e.getClientRects().length&&/消息|私信|message|说点什么/i.test((e.placeholder||'')+' '+(e.getAttribute('data-placeholder')||'')+' '+(e.getAttribute('aria-label')||'')));if(!input)return false;if(input.isContentEditable){input.textContent=data.text;input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:data.text}));}else{Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set?.call(input,data.text);input.dispatchEvent(new Event('input',{bubbles:true}));}scope.setAttribute('data-fengsha-contact',data.id);return true;})(${JSON.stringify(p)})`);
    if(!ready)throw new Error('未能核对官方聊天窗口的接收者或输入框，请在官方客户端完成联系');
    await delay(500,undefined,{signal});signal.throwIfAborted();
    // Persist an uncertain attempt before clicking; a lost page response must not
    // cause a retry that sends the same message twice.
    this.prepared={...p,status:'uncertain',attemptedAt:Date.now()};this.store.put('contact-message',p.id,this.prepared);this.store.flush();
    const result=await w.webContents.executeJavaScript(`(id=>{const scope=[...document.querySelectorAll('[data-fengsha-contact]')].find(e=>e.getAttribute('data-fengsha-contact')===id);const button=scope&&[...scope.querySelectorAll('button')].find(e=>e.getClientRects().length&&!e.disabled&&/^(发送|Send)$/.test(e.innerText.trim()));if(!button)return {submitted:false};button.click();return {submitted:true};})(${JSON.stringify(p.id)})`);
    if(!result.submitted){this.prepared=p;this.store.put('contact-message',p.id,p);this.store.flush();throw new Error('官方发送按钮尚未就绪，请完成登录或在官方窗口手动发送');}
    this.prepared={...p,status:'uncertain',attemptedAt:Date.now()};this.store.put('contact-message',p.id,this.prepared);this.store.flush();return {...this.prepared,message:'已点击官方发送按钮，送达状态尚未确认；请核对聊天记录，不会自动重试。'};
  }
}
