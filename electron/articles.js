import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {articleLinks,articleRequest,articleURL,articleIdentity,articleFiles,imageURL} from './article-data.js';

export class Articles {
  constructor({store,reader,directory,changed=()=>{}}){
    Object.assign(this,{store,reader,directory,changed});this.active=null;this.record=store.get('article-meta','discovery');
    if(this.record){for(const item of this.record.items)if(['reading','queued'].includes(item.status))item.status='interrupted';if(this.record.status==='reading')this.record.status='interrupted';}
  }
  view(){return {busy:!!this.active,discovery:this.record,library:this.store.list('article').sort((a,b)=>b.savedAt-a.savedAt).map(({blocks,text,images,assets,...a})=>({...a,imageCount:images?.length||0,savedImages:assets?.length||0})),directory:this.directory};}
  get(id){const r=this.store.get('article',id);if(!r)throw Error('文章不存在');return r;}
  intact(article){return article?.status==='saved'&&['article.json','article.md','article.html','article.txt',...(article.assets||[]).map(a=>a.file)].every(file=>{const target=path.resolve(article.directory,file),relative=path.relative(path.resolve(article.directory),target);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&fs.existsSync(target)&&fs.statSync(target).size>0;});}
  publish(){if(this.record)this.store.put('article-meta','discovery',this.record);this.changed();}
  async run(fn){
    if(this.active)throw Error('文章采集正在进行，请等待或先停止');const controller=this.active=new AbortController();
    this.pending=(async()=>{try{await fn(controller.signal);}catch(e){if(this.record){this.record.status=controller.signal.aborted?'interrupted':'failed';this.record.message=controller.signal.aborted?'已停止，已有文章保留。':e.message;}}finally{this.active=null;this.publish();}})();
    this.publish();await this.pending;return this.view();
  }
  start(raw){const request=articleRequest(raw);return this.run(async signal=>{
    this.reader.close();this.record={id:randomUUID(),request,status:'reading',items:[],message:'正在读取文章列表…',next:null};this.publish();
    if(request.mode==='links'){
      this.record.items=articleLinks(request.input);this.publish();
      for(const item of this.record.items){signal.throwIfAborted();item.status='reading';this.record.message='正在识别文章信息…';this.publish();
        try{const info=await this.reader.read(item.url,signal,{metadataOnly:true});signal.throwIfAborted();let thumbnail='';try{thumbnail=imageURL(info.thumbnail);}catch{}Object.assign(item,{title:info.title,author:info.author||'',publishedAt:info.publishedAt||null,thumbnail,status:'identified',error:''});}
        catch(e){signal.throwIfAborted();item.status='failed';item.error=e.message;if(e.needsAction){this.record.status='needs-action';this.record.message=e.message;break;}}
        finally{this.publish();}
      }
      if(this.record.status!=='needs-action'){this.record.status='ready';this.record.message='已读取文章信息，尚未保存正文和图片。请选择需要的文章后保存。';}
    }
    else await this.discover(signal,true);
  });}
  more(){if(!this.record||this.record.request.mode==='links')throw Error('当前没有可继续读取的列表');return this.run(signal=>this.discover(signal,false));}
  async discover(signal,initial){
    this.record.status='reading';this.publish();const page=await this.reader.discover(this.record.request,initial?null:this.record,signal);signal.throwIfAborted();
    if(page.authorContext)this.record.authorContext=page.authorContext;
    const found=new Map(this.record.items.map(i=>[i.id,i]));for(const item of page.items||[]){const parsed=articleURL(item.url,{result:true});if(!found.has(parsed.id))found.set(parsed.id,{...item,...parsed,title:item.title||parsed.title});}
    this.record.items=[...found.values()].slice(0,500);this.record.next=page.next??null;this.record.overflow=page.overflow||[];this.record.endReached=!!page.endReached;this.record.status=page.needsAction?'needs-action':'ready';this.record.message=page.message||'已读取列表，请选择文章保存。';this.record.complete=!!page.complete;this.record.limitReached=found.size>=500;if(this.record.limitReached)this.record.message+=' 本次清单已达 500 条上限，请先保存所需文章。';this.publish();
  }
  collect(ids){
    if(!Array.isArray(ids)||!ids.length||ids.length>100||!this.record)throw Error('请选择 1–100 篇文章');
    const selected=[...new Set(ids)].map(id=>this.record.items.find(i=>i.id===id));if(selected.some(i=>!i))throw Error('选择的文章已不在本次列表中');
    return this.run(async signal=>{
      this.record.status='reading';for(const i of selected)i.status='queued';this.publish();
      try {for(const item of selected){
        signal.throwIfAborted();item.status='reading';item.error='';this.record.message=`正在保存：${item.title}`;this.publish();
        try {
          const expected=this.record.authorContext,checkAuthor=article=>{if(expected&&(article.author!==expected.name||expected.biz&&article.sourceIdentity?.biz!==expected.biz))throw Error('文章作者身份与原文不匹配，已拒绝保存；可能是同名公众号');};
          const old=this.store.get('article',item.savedId||item.id);if(old)checkAuthor(old);
          if(this.intact(old)){Object.assign(item,{status:'saved',savedId:old.id,title:old.title,author:old.author,publishedAt:old.publishedAt});continue;}
          const article=await this.reader.read(item.url,signal);signal.throwIfAborted();
          checkAuthor(article);
          const identity=articleIdentity(article);Object.assign(article,identity,{title:article.title});
          if(!article.title||!Array.isArray(article.blocks)||!article.blocks.length)throw Error('页面没有返回完整文章正文');
          const exists=this.store.get('article',article.id);
          if(this.intact(exists)){Object.assign(item,{status:'saved',savedId:exists.id,title:exists.title,author:exists.author,publishedAt:exists.publishedAt});continue;}
          const saved=await this.save(article,signal);signal.throwIfAborted();this.store.put('article',saved.id,saved);this.store.flush();Object.assign(item,{savedId:saved.id,title:saved.title,author:saved.author,status:saved.status,error:saved.failures.map(f=>f.error).join('；')});
        }catch(e){item.status=signal.aborted?'cancelled':'failed';item.error=signal.aborted?'已停止':e.message;if(signal.aborted)throw e;if(e.needsAction){this.record.status='needs-action';this.record.message=e.message;break;}}
        finally{this.publish();}
        if(selected.indexOf(item)<selected.length-1)await delay(1200,undefined,{signal});
      }}finally{for(const item of selected)if(['queued','reading'].includes(item.status))item.status=signal.aborted?'cancelled':'pending';}
      if(this.record.status!=='needs-action'){this.record.status='ready';const failed=selected.filter(i=>['failed','partial'].includes(i.status)).length;this.record.message=failed?`本次有 ${failed} 篇未完整保存，可选择后重试。`:'本次采集结束，已保存文章可在文章库查看。';}
    });
  }
  async save(article,signal){
    const directory=path.join(this.directory,article.platform,article.id+'-'+randomUUID().slice(0,8)),assets=[],failures=[];fs.mkdirSync(path.join(directory,'images'),{recursive:true});
    try {
      const images=[...new Set(article.images||[])];if(images.length>100)throw Error('文章图片超过单篇 100 张上限，未标记为完整保存');let total=0;
      for(const url of images){signal.throwIfAborted();try{const image=await this.reader.image(url,signal);signal.throwIfAborted();total+=image.bytes.length;if(total>150*1024*1024)throw Error('单篇图片总大小超过 150 MB');const file=`images/${String(assets.length+1).padStart(3,'0')}.${image.ext}`;if(!/^(png|jpg|gif|webp)$/.test(image.ext))throw Error('不支持的图片格式');fs.writeFileSync(path.join(directory,file),image.bytes);assets.push({url,file});}catch(e){signal.throwIfAborted();failures.push({url,error:e.message});}}
      signal.throwIfAborted();const saved={...article,images,assets,failures,directory,savedAt:Date.now(),status:failures.length?'partial':'saved'},files=articleFiles(saved,assets);
      fs.writeFileSync(path.join(directory,'article.md'),files.markdown);fs.writeFileSync(path.join(directory,'article.html'),files.html);fs.writeFileSync(path.join(directory,'article.txt'),files.text);fs.writeFileSync(path.join(directory,'article.json'),JSON.stringify(saved,null,2));return saved;
    }catch(e){const relative=path.relative(path.resolve(this.directory),path.resolve(directory));if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(directory,{recursive:true,force:true});throw e;}
  }
  cancel(){this.active?.abort();this.reader.close();}
  async close(){this.cancel();await this.pending?.catch(()=>{});this.reader.close();await this.reader.shutdown?.();}
}
