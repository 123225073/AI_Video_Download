import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {platformOf,validSource} from './core.js';
import {createStableVideoArticle as createVideoArticle} from './video-article.js';
import {prepareArticlePrompts,promptHash} from './article-prompts.js';
import {generateArticleImages} from './article-images.js';
const running=new Set(['queued','preparing','subtitles','transcribing','correcting','summarizing','translating']);
export const videoTitle=value=>String(value||'').replace(/<\/?em\b[^>]*>/gi,'').replace(/&amp;/g,'&').trim();
const textHash=value=>createHash('sha256').update(String(value||'')).digest('hex');
export function correctedVideoSource(t){
  if(!t?.transcript?.trim()||t.transcriptPartial)throw Error('请先完成视频口播提取，不能把作品说明当成完整口播');
  if(!t.correctedTranscript?.trim())throw Object.assign(Error('请先完成 AI 校对并保存校对稿，再生成二创或图文；口播原文可能存在识别错误'),{code:'VIDEO_CORRECTION_REQUIRED'});
  if(t.correctionCandidate?.contentComplete&&t.correctionCandidate?.correctionValidated&&!t.correctionCandidate.manualAccepted&&!t.correctionCandidate.supersededAt&&(t.correctionCandidate.verification?.numbersChanged||t.correctionCandidate.reason==='CORRECTION_NUMBERS_CHANGED'))throw Error('最新校对候选含待核对的数字，请先核对并保存校对稿');
  if(t.correctionSourceHash&&t.correctionSourceHash!==textHash(t.transcript))throw Error('口播原文已更新，请重新校对后再创作');
  return {text:t.correctedTranscript,hash:textHash(t.correctedTranscript)};
}
export function videoCreativeSource(r,d,t,reference='corrected'){
  const corrected=correctedVideoSource(t);
  if(!['corrected','current'].includes(reference))throw Error('二创请使用 AI 校对稿；原文保留用于对照');
  if(reference==='current'&&d.body!==corrected.text&&r?.rewriteSourceHash!==corrected.hash)throw Error('当前二创稿未基于最新校对稿生成，请先选择 AI 校对稿重新二创');
  return {...corrected,text:reference==='current'?d.body:corrected.text,title:videoTitle(reference==='current'?d.title:d.original.title),reference};
}

export class VideoWorkflow {
  constructor({store,studio,transcriptions,engine,ai,bin,changed=()=>{},pollMs=1000,articleCreator=createVideoArticle}){Object.assign(this,{store,studio,transcriptions,engine,ai,bin,changed,articleCreator});this.closed=false;this.ticking=false;this.jobs=new Set();this.mediaJobs=new Map();this.articleJobs=new Map();for(const r of store.list('video-workflow'))if(r.articlePreview?.status==='running'){r.articlePreview={...r.articlePreview,status:'interrupted',label:'上次图文创作中断，已校验正文和已完成配图保留'};r.message=r.articlePreview.label;r.lastAction='article';r.endedAt=Date.now();store.put('video-workflow',r.id,r);store.flush();}if(pollMs){this.timer=setInterval(()=>this.tick().catch(()=>{}),pollMs);this.timer.unref();}}
  record(id){const r=this.store.get('video-workflow',id);if(!r)throw Error('视频任务不存在');return r;}
  creativeSource(r,d,t,reference='corrected'){
    return videoCreativeSource(r,d,t,reference);
  }
  openDraft(draftId){const d=this.studio.get(draftId);if(d.source.type!=='video')throw Error('此稿件属于图文复刻');const existing=this.store.list('video-workflow').find(r=>r.draftId===draftId);if(existing)return this.get(existing.id);if(!d.transcriptionId)return null;const id=randomUUID();this.store.put('video-workflow',id,{id,draftId,transcriptionId:d.transcriptionId,sourceKey:createHash('sha256').update(d.source.url||d.id).digest('hex'),sourceUrl:d.source.url,autoCorrect:false,createdAt:d.createdAt,startedAt:d.extractionStartedAt||d.createdAt,message:d.message});this.store.flush();return this.get(id);}
  list(){return this.store.list('video-workflow').sort((a,b)=>b.createdAt-a.createdAt).map(r=>{const d=this.get(r.id);return {id:r.id,title:d.title,status:d.status,busy:d.busy,message:d.message,createdAt:r.createdAt};});}
  get(id){const r=this.record(id),d=this.studio.get(r.draftId),t=this.store.get('transcription',r.transcriptionId),busy=running.has(t?.status)||this.jobs.has(id);const status=busy?t?.status==='correcting'||t?.correctionOnly?'correcting':'processing':r.paused||['cancelled','interrupted'].includes(t?.status)?'interrupted':t?.status==='no-speech'?'no-speech':t?.status==='ai-failed'?'ai-failed':t?.status==='failed'?'failed':t?.transcript&&!t.transcriptPartial?'ready':'interrupted';
    const file=[d.originalVideoFile,t?.sourceFile,t?.source?.file].find(f=>f&&fs.existsSync(f)&&/\.(mp4|mkv|mov|webm)$/i.test(f)),hasVideo=!!file;
    const job=this.studio.progress()?.draftId===d.id?this.studio.progress():null,articleJob=this.articleJobs.get(id),jobStatus=articleJob?r.articlePreview?.stage==='images'?'generating-images':'planning-article':this.mediaJobs.has(id)?'fetching-video':this.jobs.has(id)?job?.stage==='rewrite'?'rewriting':'frames':!busy&&r.lastAction==='article'&&r.articlePreview?.status?({'completed':'article-ready','interrupted':'article-interrupted','cancelled':'article-interrupted','failed':'article-failed'}[r.articlePreview.status]||status):status;
    const output=r.article?.draftId?this.store.get('content-draft',r.article.draftId):null;
    const article=r.article?{...r.article,title:output?.title??r.article.title,body:output?.body??r.article.body,bodyEdited:!!output&&output.body!==r.article.body,pages:r.article.pages.map(p=>({...p,imageCurrent:!!p.imageAssetId&&!!output?.assets?.some(a=>a.id===p.imageAssetId&&a.file&&fs.existsSync(a.file))&&p.generatedPromptHash===promptHash(r.article.imageStyle,p.generationPrompt),preview:p.imageAssetId?`fengsha-media://draft-${r.article.draftId}/${p.imageAssetId}`:null}))}:null;
    const reviewPending=!!t?.correctionCandidate?.contentComplete&&!!t.correctionCandidate.correctionValidated&&!t.correctionCandidate.manualAccepted&&!t.correctionCandidate.supersededAt&&!!(t.correctionCandidate.verification?.numbersChanged||t.correctionCandidate.reason==='CORRECTION_NUMBERS_CHANGED');const correctedHash=t?.correctedTranscript?textHash(t.correctedTranscript):null,correctionReady=!reviewPending&&!!correctedHash&&!t.transcriptPartial&&(!t.correctionSourceHash||t.correctionSourceHash===textHash(t.transcript));const rewriteStale=!!d.body&&d.body!==t?.correctedTranscript&&r.rewriteSourceHash!==correctedHash;
    const correctionState=t&&this.transcriptions.get?this.transcriptions.get(r.transcriptionId):t;
    return {...r,article,correctionReady,correctedHash,rewriteStale,currentSourceHash:correctionState?.currentSourceHash||textHash(t?.transcript),candidateHash:correctionState?.candidateHash,correctedCandidateHash:correctionState?.correctedCandidateHash,title:videoTitle(t?.title||d.title),status:jobStatus==='ready'&&reviewPending?'correction-review':jobStatus,busy,message:articleJob?r.articlePreview?.label||'正在将视频整理为图文':this.mediaJobs.has(id)?'正在按需取得原视频，已有文稿保留':this.jobs.has(id)?job?.label||'正在处理视频':busy?t?.message||'正在处理视频':r.lastAction==='article'||r.paused?r.message:status==='failed'||status==='interrupted'?t?.message||r.message:r.correctedApplied?r.message:t?.message||r.message||'任务已中断，可继续',progress:articleJob?(r.articlePreview?.stage==='images'?70+Math.floor(25*(r.articlePreview.completed||0)/Math.max(1,r.articlePreview.total||1)):45):r.lastAction==='article'?(r.articlePreview?.status==='completed'?100:r.articlePreview?.stage==='images'?70+Math.floor(25*(r.articlePreview.completed||0)/Math.max(1,r.articlePreview.total||1)):45):t?.progress||0,downloadProgress:t?.downloadProgress,description:d.original.description||d.source.text||'',original:t?.transcript||'',partial:!!t?.transcriptPartial,corrected:t?.correctedTranscript||'',correctionPreview:t?.correctionPreview||null,correctionCandidate:t?.correctionCandidate||null,segments:t?.segments||[],body:d.body,draft:d,preview:hasVideo?`fengsha-media://transcript-${r.transcriptionId}/video`:null,hasVideo,startedAt:t?.status==='correcting'?t.correctionStartedAt||r.startedAt:r.startedAt,endedAt:busy?null:r.endedAt||t?.completedAt||t?.updatedAt,job};
  }
  source(raw){let d=raw.draftId?this.studio.get(raw.draftId):null;let item=d?.source;if(!item&&raw.recordId)item=this.studio.search.item(raw.recordId,raw.itemId).item;
    if(!item&&raw.creatorId){const creator=this.store.get('creator',raw.creatorId);item=creator?.items.find(i=>i.key===raw.itemId||i.id===raw.itemId);if(!item)throw Error('博主作品已不存在，请重新读取列表');item={...item,type:'video'};}
    if(!item&&raw.mediaId){const media=this.store.get('media',raw.mediaId);if(!media||!fs.existsSync(media.filePath))throw Error('媒体文件已不存在，请重新定位');item={...media,id:media.sourceId||media.id,type:'video'};}
    if(!item&&raw.item){item={id:String(raw.item.id||raw.item.key||raw.item.url),platform:raw.item.platform||platformOf(raw.item.url),type:'video',url:String(raw.item.url||''),title:videoTitle(raw.item.title),text:'',images:[]};}
    if(raw.inputId||raw.url?.trim()&&raw.url.trim()!==item?.url){d=null;item=null;}
    if(item&&item.type!=='video')throw Error('图文作品请在图文复刻中处理');
    const url=String(raw.url||item?.url||'').trim(),input=raw.inputId?this.store.get('transcription-input',raw.inputId):null;if(raw.inputId&&(!input||!fs.existsSync(input.file)||!['mp4','mkv','mov','webm'].includes(input.ext)))throw Error('请选择有效的本地视频');
    const media=raw.mediaId&&!raw.url&&!raw.inputId?this.store.get('media',raw.mediaId):this.store.list('media').find(m=>m.platform===(item?.platform||platformOf(url))&&(item?.id&&m.sourceId===item.id||m.url===url)&&m.filePath&&fs.existsSync(m.filePath));
    const linked=d?.transcriptionId?this.store.get('transcription',d.transcriptionId):null;const local=[input?.file,d?.originalVideoFile,linked?.sourceFile,media?.filePath].find(file=>file&&fs.existsSync(file)&&/\.(mp4|mkv|mov|webm)$/i.test(file));
    if(local&&fs.existsSync(local)&&/\.(mp4|mkv|mov|webm)$/i.test(local))return {d,item,url,file:local,key:path.resolve(local)};
    validSource(url);const u=new URL(url);if(platformOf(url)==='视频号'&&u.pathname==='/web/pages/feed'&&!this.engine.wechat.collector?.cached?.({sourceId:u.searchParams.get('oid')}))throw Object.assign(Error('这份旧记录只有说明和封面，未保存视频媒体。请粘贴视频号公开分享链接，或导入已有视频；不会再次打开微信等待。'),{code:'VIDEO_SHARE_REQUIRED'});
    return {d,item,url,key:url};
  }
  start(raw={}){if(this.closed)throw Error('应用正在退出');const s=this.source(raw),key=createHash('sha256').update(s.key).digest('hex'),existing=this.store.list('video-workflow').find(r=>r.sourceKey===key);if(existing)return {...this.get(existing.id),reused:true};
    const input=s.file?this.transcriptions.choose(s.file):null,t=this.transcriptions.start(input?{inputId:input.id}:{url:s.url,title:s.item?.title||'视频复刻'});const id=randomUUID(),d=s.d||{id:randomUUID(),source:s.item||{id:key,platform:platformOf(s.url)||'本地视频',type:'video',url:s.url,title:path.basename(s.file||'视频复刻'),text:'',images:[]},original:{title:s.item?.title||path.basename(s.file||'视频复刻'),text:'',images:[],description:s.item?.text||''},title:s.item?.title||path.basename(s.file||'视频复刻'),body:'',tags:'',assets:[],assetOrder:[],revision:1,createdAt:Date.now()};
    if(s.file)d.originalVideoFile=s.file;d.original.description=d.original.description||d.source.text||'';d.transcriptionId=t.id;d.originalTextKind='transcript';d.status='transcribing';d.extractionStartedAt=Date.now();delete d.extractionEndedAt;d.message='视频下载与转录已开始';this.studio.checkpoint(d);
    const record={id,draftId:d.id,transcriptionId:t.id,sourceKey:key,sourceUrl:s.url,autoCorrect:raw.autoCorrect!==false,createdAt:Date.now(),startedAt:Date.now(),message:'已开始独立视频处理'};this.store.put('video-workflow',id,record);this.store.flush();this.changed();return this.get(id);
  }
  async tick(){if(this.closed||this.ticking)return;this.ticking=true;try{for(const r of this.store.list('video-workflow')){const t=this.store.get('transcription',r.transcriptionId);if(!t)continue;
    if(t.title){const d=this.studio.get(r.draftId);if(d.original.title!==t.title){if(d.title===d.original.title)d.title=t.title;d.original.title=t.title;d.source.title=t.title;d.revision++;this.studio.checkpoint(d);}}
    if(t.transcript&&!t.transcriptPartial&&['ready','archived'].includes(t.status)&&r.autoCorrect&&!r.paused&&!r.correctionStarted&&!this.jobs.has(r.id)){r.correctionStarted=true;const c=this.ai.config('text');if(c.hasKey&&c.model){r.message='正在复用原文进行 AI 校对';this.store.put('video-workflow',r.id,r);await this.transcriptions.action(t.id,'correct').catch(e=>{r.message=e.message;});}else r.message='转录已完成。尚未配置文本模型，可稍后单独 AI 校对。';this.store.put('video-workflow',r.id,r);this.store.flush();this.changed();}
    const latest=this.store.get('transcription',r.transcriptionId);let correctedUsable=false;try{correctedVideoSource(latest);correctedUsable=true;}catch{}if(correctedUsable&&!running.has(latest.status)&&!r.correctedApplied){const d=this.studio.get(r.draftId);if(d.body===latest.transcript||!d.body){d.body=latest.correctedTranscript;d.revision++;this.studio.checkpoint(d);}r.correctedApplied=true;r.message='视频转录与 AI 校对已完成，原文保留，可继续二创';this.store.put('video-workflow',r.id,r);this.store.flush();this.changed();}
  }}finally{this.ticking=false;}}
  saveArticle(r,result,sourceHash,complete=true,reuseId,preserveEdits=false){
    if(!result.imageStyle||result.pages.some(p=>!p.generationPrompt))result=prepareArticlePrompts(result,r.articleOptions?.style!=='auto'?r.articleOptions?.style:undefined);
    const parent=this.studio.get(r.draftId),previous=reuseId?this.store.get('content-draft',reuseId):null,id=previous?.id||randomUUID(),assets=(result.pages||[]).filter(p=>p.imageFile&&fs.existsSync(p.imageFile)).map(p=>({id:previous?.assets.find(a=>a.pageId===p.id&&a.file===p.imageFile)?.id||randomUUID(),file:p.imageFile,kind:'image',origin:'imported',generatedBy:'video-article',pageId:p.id,prompt:p.imagePrompt}));
    const pages=result.pages.map(p=>{const a=assets.find(a=>a.pageId===p.id);const {imageFile,...rest}=p;return {...rest,...(a?{imageAssetId:a.id}:{})};});
    const draft={id,source:{...parent.source,id:parent.source.id+'-article-'+id,type:'image',title:result.title},original:{title:videoTitle(parent.original.title),text:this.store.get('transcription',r.transcriptionId)?.transcript||parent.original.text,images:[],description:parent.original.description||''},title:result.title,body:result.body,tags:'',visibility:'public',assets,assetOrder:assets.map(a=>a.id),revision:1,status:'draft',createdAt:Date.now(),derivedFromVideo:{workflowId:r.id,draftId:r.draftId,transcriptionId:r.transcriptionId,sourceHash},articlePages:pages,message:complete?'视频已整理为图文，原视频与原文保留': '图文方案已保存，部分配图未完成，可继续编辑'};
    draft.createdAt=previous?.createdAt||draft.createdAt;draft.revision=previous?previous.revision+1:1;
    if(preserveEdits&&previous){for(const key of ['title','body','tags','visibility'])draft[key]=previous[key];const extra=previous.assets.filter(a=>a.generatedBy!=='video-article');draft.assets.push(...extra);draft.assetOrder=[...previous.assetOrder.filter(id=>extra.some(a=>a.id===id)),...assets.map(a=>a.id)];}
    this.studio.checkpoint(draft);r.article={...result,pages,draftId:id,sourceHash,createdAt:draft.createdAt,status:complete?'completed':'partial',generatedCount:assets.length};this.store.put('meta','lastContentDraft',{id});this.store.put('video-workflow',r.id,{...this.record(r.id),article:r.article});this.store.flush();return draft;
  }
  async article(id,options={}){
    if(this.get(id).busy)throw Error('正在处理当前视频，请等待或停止');
    const r=this.record(id),d=this.studio.get(r.draftId),t=this.store.get('transcription',r.transcriptionId);
    const continuing=options.resume===true;
    if(continuing)options={...(r.articleOptions||options),resume:true,generateImages:false};
    const base=this.creativeSource(r,d,t,options.reference||'corrected'),text=base.text;
    const sourceHash=createHash('sha256').update(text).digest('hex'),file=[d.originalVideoFile,t.sourceFile,t.source?.file].find(f=>f&&fs.existsSync(f)&&/\.(mp4|mkv|webm|mov)$/i.test(f));
    let recovery=continuing?r.articleRecovery?.value:undefined;
    if(continuing&&r.articleRecovery?.sourceHash&&r.articleRecovery.sourceHash!==sourceHash)throw Error('校对稿或创作基准已变更，请重新创作，旧候选保留');
    if(continuing&&!recovery&&r.articlePreview?.pages?.length){recovery={candidate:{...r.articlePreview,pages:r.articlePreview.pages.map(p=>({...p,imagePrompt:p.imagePrompt||`以${p.title}为主题，依据本页正文设计统一画风的示意画面，不添加新事实`}))}};}
    if(continuing&&!recovery)throw Error('没有可继续的图文候选，请创作新方案');
    if(continuing&&recovery&&(r.articlePreview?.validation?.numeric==='failed'||r.articlePreview?.validation?.audit==='failed'))recovery={...recovery,validationIssues:{numericIssues:r.articlePreview.numericIssues||[],auditIssues:r.articlePreview.auditIssues||[]}};
    r.articleOptions={...options};delete r.articleOptions.resume;
    if(!continuing)r.articleRecovery=null;
    const ensureBase=()=>{if(correctedVideoSource(this.store.get('transcription',r.transcriptionId)).hash!==base.hash||this.studio.get(r.draftId).revision!==d.revision)throw Error('创作期间校对稿或当前文案已变更，请使用最新稿重新生成');};
    let previewSavedAt=Date.now();const controller=new AbortController(),job={controller,promise:null};r.paused=false;r.startedAt=Date.now();delete r.endedAt;r.lastAction='article';r.articlePreview={stage:'planning',label:'正在理解视频并规划图文',text:'',status:'running'};this.store.put('video-workflow',id,r);this.jobs.add(id);this.articleJobs.set(id,job);this.changed();
    try{
      job.promise=this.studio.exclusive(async signal=>{ensureBase();return this.articleCreator({ai:this.ai,bin:this.bin,directory:path.join(this.studio.directory,r.draftId,'图文输出'),source:{title:base.title,text,description:'',file},options:{...options,reference:base.reference,generateImages:options.generateImages===true},recovery,onRecovery:value=>{r.articleRecovery={value,sourceHash};this.store.put('video-workflow',id,{...this.record(id),articleRecovery:r.articleRecovery});},signal:AbortSignal.any([signal,controller.signal]),onCheckpoint:result=>{ensureBase();const saved=this.saveArticle(r,result,sourceHash,false,job.draftId);job.draftId=saved.id;},onPreview:p=>{if(controller.signal.aborted)return;r.articlePreview={...p,status:'running'};this.store.put('video-workflow',id,{...this.record(id),articlePreview:r.articlePreview});if(Date.now()-previewSavedAt>=1000){this.store.flush();previewSavedAt=Date.now();}this.changed();}});});
      const result=await job.promise;ensureBase();if(controller.signal.aborted)throw Object.assign(Error('已停止图文创作，已完成结果保留'),{partial:result});this.saveArticle(r,result,sourceHash,true,job.draftId);r.articlePreview={...r.articlePreview,status:'completed'};r.message=options.generateImages===true?'图文正文、分页与配图已保存':'图文正文和分页配图方案已保存，未调用图片模型';
    }catch(e){let currentBase=true;try{ensureBase();}catch{currentBase=false;}if(currentBase&&e.partial?.pages?.length&&e.partial.body)this.saveArticle(r,e.partial,sourceHash,false,job.draftId);r.articlePreview={...r.articlePreview,status:controller.signal.aborted?'cancelled':'failed',label:e.message,...(e.numericIssues?{numericIssues:e.numericIssues}:{}),...(e.auditIssues?{auditIssues:e.auditIssues}:{})};r.message=controller.signal.aborted?'已停止图文创作，原视频和已有结果保留':e.message;throw e;}
    finally{r.endedAt=Date.now();this.store.put('video-workflow',id,{...this.record(id),article:r.article||this.record(id).article,articlePreview:r.articlePreview,message:r.message,lastAction:'article',endedAt:r.endedAt});this.store.flush();this.articleJobs.delete(id);this.jobs.delete(id);this.changed();}
    return this.get(id);
  }
  async articleImages(id,options={}){
    if(this.get(id).busy)throw Error('正在处理当前视频，请等待或停止');
    const r=this.record(id),article=r.article;
    if(!article)throw Error('请先完成并校验图文方案');
    if(options.draftId!==article.draftId||options.promptRevision!==(article.promptRevision||0))throw Error('图文或提示词已更新，请重新打开后生成');
    const output=this.store.get('content-draft',article.draftId);
    if(output.body!==article.body||output.title!==article.title)throw Error('图文正文已在编辑器修改，请重新创作分页方案后再生图，避免使用旧分页');
    const controller=new AbortController(),job={controller,promise:null};
    this.jobs.add(id);this.articleJobs.set(id,job);r.lastAction='article';r.startedAt=Date.now();r.articlePreview={status:'running',stage:'images',label:'正在按已保存提示词生成配图'};
    this.store.put('video-workflow',id,r);this.changed();
    const input={...article,pages:article.pages.map(p=>({...p,imageFile:output.assets.find(a=>a.id===p.imageAssetId)?.file}))};
    try{
      job.promise=this.studio.exclusive(signal=>generateArticleImages({article:input,ai:this.ai,directory:path.join(this.studio.directory,r.draftId,'图文输出','配图'),signal:AbortSignal.any([signal,controller.signal]),onCheckpoint:result=>this.saveArticle(r,result,article.sourceHash,false,article.draftId,true),onPreview:p=>{r.articlePreview={...p,status:'running'};this.store.put('video-workflow',id,{...this.record(id),articlePreview:r.articlePreview});this.changed();}}));
      const result=await job.promise;this.saveArticle(r,result,article.sourceHash,true,article.draftId,true);r.articlePreview={...r.articlePreview,status:'completed'};r.message='配图已保存；再次生成会跳过提示词相同且文件完整的图片';
    }catch(e){r.articlePreview={...r.articlePreview,status:controller.signal.aborted?'cancelled':'failed',label:e.message};r.message='配图中断，已完成图片保留，可继续生成剩余配图';throw e;}
    finally{this.store.put('video-workflow',id,{...this.record(id),articlePreview:r.articlePreview,message:r.message,endedAt:Date.now()});this.store.flush();this.articleJobs.delete(id);this.jobs.delete(id);this.changed();}
    return this.get(id);
  }
  savePrompts(id,options={}){
    if(this.get(id).busy)throw Error('正在处理当前视频，请等待或停止');
    const r=this.record(id),article=r.article;
    if(!article)throw Error('请先完成并校验图文方案');
    if(options.draftId!==article.draftId||options.promptRevision!==(article.promptRevision||0))throw Error('图文或提示词已更新，请重新打开再编辑');
    let next=prepareArticlePrompts(article);
    if(options.pages){
      if(typeof options.imageStyle!=='string'||!options.imageStyle.trim()||options.imageStyle.length>4000)throw Error('统一画风须填写，最多4000字');
      if(!Array.isArray(options.pages)||options.pages.length!==article.pages.length||new Set(options.pages.map(p=>p.id)).size!==article.pages.length)throw Error('提示词页数或绑定不一致');
      next.imageStyle=options.imageStyle.trim();
      next.pages=next.pages.map(p=>{const edit=options.pages.find(v=>v.id===p.id);if(typeof edit?.generationPrompt!=='string'||!edit.generationPrompt.trim()||edit.generationPrompt.length>20000)throw Error('每页提示词须填写，最多20000字');return {...p,generationPrompt:edit.generationPrompt.trim()};});
    }
    r.article=next;this.store.put('video-workflow',id,r);this.store.flush();this.changed();return this.get(id);
  }
  async action(id,action,options={}){const r=this.record(id);if(action==='cancel'){r.paused=true;this.store.put('video-workflow',id,r);this.store.flush();const mediaJob=this.mediaJobs.get(id),articleJob=this.articleJobs.get(id);mediaJob?.controller.abort();articleJob?.controller.abort();if(this.studio.progress()?.draftId===r.draftId&&this.studio.progress().running)await this.studio.cancel(r.draftId);await mediaJob?.promise.catch(()=>{});await articleJob?.promise.catch(()=>{});await this.transcriptions.action(r.transcriptionId,'cancel');const latest=this.record(id);Object.assign(r,latest,{paused:true});if(latest.article)r.article=latest.article;if(latest.articlePreview)r.articlePreview={...latest.articlePreview,status:'cancelled'};r.endedAt=Date.now();r.message='已停止，视频与已取得文稿保留';}
    else if(action==='resume'){r.paused=false;r.startedAt=Date.now();delete r.endedAt;r.message='正在继续处理，已有素材复用';const d=this.studio.get(r.draftId);d.status='transcribing';d.extractionStartedAt=r.startedAt;delete d.extractionEndedAt;d.revision++;this.studio.checkpoint(d);await this.transcriptions.action(r.transcriptionId,'retry');}
    else if(action==='correct'){if(this.get(id).busy)throw Error('正在处理当前视频，请等待或停止');r.paused=false;r.correctionStarted=true;r.correctedApplied=false;r.startedAt=Date.now();delete r.endedAt;r.lastAction='correct';this.store.put('video-workflow',id,r);await this.transcriptions.action(r.transcriptionId,'correct',options);r.message='正在复用原文进行 AI 校对';}
    else if(action==='accept-correction'){if(options.workflowId!==id||options.transcriptionId!==r.transcriptionId)throw Error('校对稿与视频任务绑定不一致，请重新打开任务');if(this.get(id).busy)throw Error('请先等待校对完成或停止');await this.transcriptions.action(r.transcriptionId,'accept-correction',options);r.correctedApplied=false;r.paused=false;r.message='已保存核对后的校对稿，二创与图文将以它为基础';this.store.put('video-workflow',id,r);await this.tick();return this.get(id);}
    else if(action==='article')return this.article(id,options);
    else if(action==='article-resume')return this.article(id,{...options,resume:true});
    else if(action==='article-prompts-save')return this.savePrompts(id,options);
    else if(action==='article-images')return this.articleImages(id,options);
    else if(action==='save'){const d=this.studio.get(r.draftId);if(options.workflowId!==id||options.draftId!==r.draftId||options.transcriptionId!==r.transcriptionId||d.transcriptionId!==r.transcriptionId)throw Error('文案与视频工作流的稿件绑定不一致，请重新打开当前任务后保存');if(this.get(id).busy)throw Error('正在处理当前视频，请等待或停止后保存');this.studio.save(d.id,{expectedDraftId:options.draftId,title:options.title||d.title,body:options.body,tags:d.tags,assetIds:d.assetOrder,revision:options.revision});r.message='二创文案已保存';}
    else if(action==='fetch-video'){if(this.get(id).hasVideo)return this.get(id);if(this.get(id).busy)throw Error('正在处理当前视频，请等待或停止');const controller=new AbortController(),job={controller,promise:null};this.jobs.add(id);this.mediaJobs.set(id,job);this.changed();try{job.promise=this.transcriptions.ensureVideo(r.transcriptionId,controller.signal);const file=await job.promise;controller.signal.throwIfAborted();const d=this.studio.get(r.draftId);d.originalVideoFile=file;this.studio.checkpoint(d);r.message='原视频已取得，可播放并提取关键帧；已有文稿保留';}finally{this.mediaJobs.delete(id);this.jobs.delete(id);this.changed();}}
    else if(action==='rewrite'||action==='frames'){if(this.jobs.has(id)||this.get(id).busy)throw Error('正在处理当前视频，请等待或停止');const base=action==='rewrite'?this.creativeSource(r,this.studio.get(r.draftId),this.store.get('transcription',r.transcriptionId),options.reference||'corrected'):null;this.jobs.add(id);try{if(action==='rewrite'){await this.studio.rewrite(r.draftId,options.prompt||'保留原意和表达风格，只做轻微润色',false,{reference:base.reference,correctedHash:base.hash});r.rewriteSourceHash=base.hash;}else await this.studio.videoFrames(r.draftId,this.bin);r.message=action==='frames'?'关键帧已从已有视频提取':'视频二创文案已保存（基于校对稿）';}finally{this.jobs.delete(id);this.changed();}}
    else throw Error('未知视频操作');this.store.put('video-workflow',id,r);this.store.flush();this.changed();return this.get(id);
  }
  async close(){this.closed=true;clearInterval(this.timer);for(const r of this.store.list('video-workflow'))if(this.get(r.id).busy)await this.action(r.id,'cancel');}
}
