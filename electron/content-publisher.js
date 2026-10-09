import { BrowserWindow, clipboard } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
export const publishURLs={ '小红书':'https://creator.xiaohongshu.com/publish/publish?source=official', '抖音':'https://creator.douyin.com/creator-micro/content/upload', 'B站':'https://member.bilibili.com/platform/upload/video/frame', YouTube:'https://studio.youtube.com/', '视频号':'https://channels.weixin.qq.com/platform/post/create' };
export function fillComposer(data){
  let title=false,body=false;const put=(el,text)=>{if(el.isContentEditable){el.textContent=text;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));}else{const setter=Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set;setter?.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}};
  for(const el of document.querySelectorAll('input,textarea,[contenteditable=true]')){const name=(el.placeholder||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('data-placeholder')||'');if(/标题|title/i.test(name)){put(el,data.title);title=true;}else if(/正文|描述|description|添加文案/i.test(name)){put(el,data.body+'\n\n'+data.tags);body=true;}}
  return {title,body};
}
// Preparation only: platform identity, visibility and the final Publish action
// are reviewed in the official composer. No API guesses or success placeholders.
export class ContentPublisher {
  constructor({accounts,studio,store}){Object.assign(this,{accounts,studio,store});this.window=null;}
  close(){if(this.window&&!this.window.isDestroyed())this.window.close();this.window=null;}
  async open(id,platform,accountId,mode='image'){
    const url=publishURLs[platform],d=this.studio.get(id),account=this.accounts.list().find(a=>a.id===accountId&&a.platform===platform);
    if(!url||!account)throw new Error('请选择该平台的发布账号');
    if(d.status!=='draft'||!d.body.trim())throw new Error('请先完成克隆内容并保存正文');
    if(!['image','video'].includes(mode))throw new Error('请选择图文或视频发布');
    if(['B站','YouTube','视频号'].includes(platform)&&mode!=='video')throw new Error('此入口需要视频，请先生成发布视频；图文素材仍可导出');
    if(mode==='image'&&!d.assetOrder.length)throw new Error('请先添加至少一张发布图片');
    if(mode==='video'&&!d.videoCurrent)throw new Error('请先生成与当前稿件及声音设置一致的发布视频');
    const exported=this.studio.export(id);clipboard.writeText(exported.body+'\n\n'+exported.tags);
    this.close();const w=this.window=new BrowserWindow({width:1150,height:850,autoHideMenuBar:true,title:`发布准备 · ${platform} · ${account.name} · 请核对官方账号`,webPreferences:{session:this.accounts.getSession(accountId),sandbox:true,contextIsolation:true,nodeIntegration:false}});w.setMenu(null);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    const host=new URL(url).hostname;w.webContents.on('will-navigate',(e,value)=>{try{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!==host)e.preventDefault();}catch{e.preventDefault();}});
    await w.loadURL(url);return this.prepared={prepared:true,published:false,directory:exported.directory,message:'已打开所选账号的官方发布窗口，正文已复制。完成登录后可点击“填入素材与文案”；话题、可见范围和最终发布请在官方页面核对。',draftId:id,platform,accountId,mode,revision:d.revision,videoFile:d.videoFile};
  }
  async fill(){const info=this.prepared;if(!info)throw new Error("请先打开发布准备窗口");const w=this.window;if(!w||w.isDestroyed())throw new Error('官方发布窗口已关闭');const d=this.studio.get(info.draftId);if(d.revision!==info.revision||info.mode==='video'&&(!d.videoCurrent||d.videoFile!==info.videoFile))throw new Error('稿件已更新，请重新打开发布窗口');
    if(new URL(w.webContents.getURL()).hostname!==new URL(publishURLs[info.platform]).hostname)throw new Error('请先返回官方发布页面');
    const e=this.studio.export(info.draftId);
    const debuggerApi=w.webContents.debugger;if(!debuggerApi.isAttached())debuggerApi.attach('1.3');
    if(info.platform==='小红书'&&info.mode==='image')await w.webContents.executeJavaScript(`{const tab=[...document.querySelectorAll('.creator-tab,.tab,button')].find(e=>/上传图文|发布图文/.test(e.textContent));if(tab)tab.click();}`);
    await delay(800);const root=await debuggerApi.sendCommand('DOM.getDocument');const inputs=await debuggerApi.sendCommand('DOM.querySelectorAll',{nodeId:root.root.nodeId,selector:'input[type=file]'});
    let uploaded=false,uploadedCount=0;
    for(const nodeId of inputs.nodeIds){const attrs=await debuggerApi.sendCommand('DOM.getAttributes',{nodeId}),map={};for(let i=0;i<attrs.attributes.length;i+=2)map[attrs.attributes[i]]=attrs.attributes[i+1];
      const accept=map.accept||'';if(info.mode==='image'&&!/image|\.png|\.jpg/i.test(accept)||info.mode==='video'&&!/video|\.mp4/i.test(accept))continue;
      await debuggerApi.sendCommand('DOM.setFileInputFiles',{nodeId,files:info.mode==='video'?[e.videoFile]:map.multiple!==undefined?e.files:e.files.slice(0,1)});uploaded=true;uploadedCount=info.mode==='video'?1:map.multiple!==undefined?e.files.length:Math.min(1,e.files.length);break;
    }
    const fields=await w.webContents.executeJavaScript(`(${fillComposer.toString()})(${JSON.stringify({title:e.title,body:e.body,tags:e.tags})})`);
    this.prepared={...info,filled:{uploaded,uploadedCount,...fields}};
    return {uploaded,uploadedCount,...fields,published:false,message:uploaded?'已提交素材到官方页面。请核对上传结果、账号、文案、可见范围后，使用官方发布按钮。':'未识别到已登录页面的素材上传入口。正文已复制、素材已导出，请在官方发布窗口手动选择素材。'};
  }
  async submit(){const info=this.prepared,w=this.window;if(!info||!w||w.isDestroyed())throw new Error('请先打开并填入官方发布窗口');
    const d=this.studio.get(info.draftId);if(d.revision!==info.revision)throw new Error('稿件已变化，请重新准备发布');
    if(!info.filled?.uploaded||!info.filled?.title||!info.filled?.body||info.mode==='image'&&info.filled.uploadedCount!==d.assetOrder.length)throw new Error('尚未确认素材、标题和正文填入完整，请在官方发布页完成后再提交');
    if(new URL(w.webContents.getURL()).hostname!==new URL(publishURLs[info.platform]).hostname)throw new Error('官方发布窗口已离开目标平台');
    const attemptId=[info.draftId,info.revision,info.platform,info.accountId].join(':');if(['uncertain','confirmed'].includes(this.store.get('publish-attempt',attemptId)?.status))throw new Error('本稿件已尝试发布到该账号，请先核对平台作品列表，避免重复');
    const privacy=await w.webContents.executeJavaScript(`(privatePost=>{const label=privatePost?/^(仅自己|私密|Private)$/:/^(公开|公开可见|Public)$/;for(const select of document.querySelectorAll('select')){const option=[...select.options].find(o=>label.test(o.text.trim()));if(option){select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));return true;}}for(const input of document.querySelectorAll('input[type=radio]')){const text=input.closest('label')?.innerText?.trim();if(text&&label.test(text)){input.click();return input.checked;}}return [...document.querySelectorAll('[aria-checked=true],[aria-selected=true],.visibility-text,.privacy-label')].some(e=>label.test(e.innerText.trim()));})(${JSON.stringify(d.visibility==='private')})`);
    if(!privacy)throw new Error('未能确认官方页面的可见范围，请先在官方页面选择并核对；不会默认为公开发布');
    let submitted=false;
    for(let i=0;i<60;i++){if(w.isDestroyed())throw new Error('发布窗口已关闭');const ready=await w.webContents.executeJavaScript(`(()=>!![...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&!e.disabled&&/^(发布|确认发布|Publish)$/.test(e.innerText.trim())))()`);if(ready){
      this.store.put('publish-attempt',attemptId,{id:attemptId,status:'uncertain',at:Date.now()});this.store.flush();
      submitted=await w.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&!e.disabled&&/^(发布|确认发布|Publish)$/.test(e.innerText.trim()));if(!button)return false;button.click();return true;})()`);break;
    }await delay(1000);}
    if(!submitted){this.store.put('publish-attempt',attemptId,{id:attemptId,status:'not-submitted',at:Date.now()});this.store.flush();throw new Error('官方发布按钮尚未就绪，请在官方窗口检查上传、账号权限或表单提示');}
    await delay(2000);const published=!w.isDestroyed()&&await w.webContents.executeJavaScript(`(()=>/发布成功|投稿成功|Successfully published|Video published/i.test(document.body.innerText))()`);
    this.store.put('publish-attempt',attemptId,{id:attemptId,status:published?'confirmed':'uncertain',at:Date.now()});this.store.flush();return {submitted:true,published,message:published?'官方页面已显示发布成功。':'已提交官方发布按钮，发布结果尚未确认，请在平台作品列表核对；不会自动重试。'};
  }
}
