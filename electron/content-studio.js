import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import { apiBase } from './ai.js';
import { command } from './engine.js';
import { mediaKey } from './core.js';
import { setTimeout as delay } from 'node:timers/promises';
import {draftTextPreview} from './ai-stream.js';
import {textRemixSystemPrompt,normalizeRemixResult,imageRemixPrompt,cleanImageInstructions,resolveAssetLineage,buildAssetPairs} from './remix-policy.js';
const safeTitle = value => String(value || '').trim().slice(0,180);
const mediaHost = host => /(^|\.)(xhscdn\.com|xiaohongshu\.com|douyinpic\.com|douyinstatic\.com|byteimg\.com|ibytedtos\.com|hdslb\.com|biliimg\.com|ytimg\.com|qpic\.cn|qq\.com)$/.test(host);
export async function assetBytes(url,fetcher=fetch,signal){
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port||!mediaHost(u.hostname))throw new Error('素材地址不属于已支持的平台图片服务');
  const response=await fetcher(u.href,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),headers:{Referer:u.hostname.endsWith('xhscdn.com')?'https://www.xiaohongshu.com/':'https://www.bilibili.com/'}});
  if(!response.ok)throw new Error(`图片获取失败（HTTP ${response.status}）`);
  if(Number(response.headers.get('content-length'))>30*1024*1024)throw new Error('图片超过 30MB');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>30*1024*1024)throw new Error('图片超过 30MB');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
export class ContentStudio {
  constructor({store,search,browser,transcriptions,ai,voice,directory,changed=()=>{},fetcher=fetch}){Object.assign(this,{store,search,browser,transcriptions,ai,voice,directory,changed,fetcher});fs.mkdirSync(directory,{recursive:true});this.active=null;for(const d of this.store.list('content-draft'))if(d.status==='cloning'){d.status='needs-action';d.message='上次克隆中断，已有正文和图片保留，可重新克隆';this.store.put('content-draft',d.id,d);}}
  progress(){return this.job?{...this.job,running:!!(this.active||this.remixController||this.flow),elapsedMs:(this.job.endedAt||Date.now())-this.job.startedAt}:null;}
  step(id,stage,label,extra={}){if(!this.job||this.job.draftId!==id||this.job.state!=='running')this.job={id:randomUUID(),draftId:id,startedAt:Date.now(),visited:[]};const canonical=['frames'].includes(stage)?'assets':stage==='transcript'?'source':stage;if(!this.job.visited.includes(canonical))this.job.visited.push(canonical);Object.assign(this.job,{stage,label,state:'running',endedAt:null,...extra});this.changed();}
  checkpoint(d){this.store.put('content-draft',d.id,d);this.store.flush();this.changed();}
  finish(state,label){if(this.job){Object.assign(this.job,{state,label,endedAt:Date.now()});this.changed();}}
  async cloneFlow(recordId,itemId,options={},bin){
    const item=this.search.item(recordId,itemId).item;
    if(!options.fresh){const existing=this.store.list('content-draft').filter(d=>d.source.platform===item.platform&&d.source.id===item.id).sort((a,b)=>b.createdAt-a.createdAt)[0];if(existing)return {...this.get(existing.id),reused:true};}
    if(this.flow||this.active||this.remixController||this.search.active)throw Error('正在处理，请等待当前操作结束');this.flow=new AbortController();try{let d=await this.clone(recordId,itemId);this.flow.signal.throwIfAborted();if(options.autoCreate)d=await this.autoRemix(d.id,bin,options.prompt||'');this.flow.signal.throwIfAborted();const partial=options.autoCreate&&d.remixSummary?.status!=='completed';this.finish(partial?'needs-action':'completed',partial?d.message:d.status==='transcribing'?'原素材已保存，视频文案正在后台提取':'克隆稿已保存，可以查看、编辑与发布准备');return d;}catch(e){this.finish(this.flow.signal.aborted?'cancelled':'failed',this.flow.signal.aborted?'已停止，已取得内容保留':e.message);throw e;}finally{this.flow=null;this.changed();}
  }
  list(){return this.store.list('content-draft').sort((a,b)=>b.createdAt-a.createdAt).map(d=>({id:d.id,title:d.title,platform:d.source.platform,sourceId:d.source.id,status:this.get(d.id).status,createdAt:d.createdAt}));}
  get(id){const d=this.store.get('content-draft',id);if(!d)throw new Error('克隆稿不存在');
    if(d.transcriptionId&&d.status==='transcribing'){
      const t=this.store.get('transcription',d.transcriptionId);
      const running=['queued','preparing','subtitles','transcribing','correcting','summarizing','translating'].includes(t?.status);
      const complete=!!t?.transcript?.trim()&&!t.transcriptPartial&&['ready','archived','completed','ai-failed'].includes(t.status);
      const previousText=d.original.text||'';
      if(t?.transcript){
        // Only advance an untouched editable copy; preserve any user-written body.
        if(!d.body||d.body===previousText)d.body=t.transcript;
        d.original.text=t.transcript;d.transcriptPartial=!complete;
      }
      if(complete||!running){
        d.status=complete?'draft':'needs-action';d.extractionEndedAt=t?.completedAt||t?.updatedAt||Date.now();
        if(complete&&t.sourceFile&&/\.(mp4|webm|mkv|mov)$/i.test(t.sourceFile)&&fs.existsSync(t.sourceFile))d.originalVideoFile=t.sourceFile;
        d.message=complete?'原视频文案已提取，右侧为可编辑副本；尚未执行 AI 二创。':(t?.message||'关联转录记录不存在，请重新克隆原作品');
        d.revision++;this.store.put('content-draft',id,d);this.store.flush();
      }else d.message=t?.message||'正在提取视频文字';
    }
    const extractionProgress=d.transcriptionId?{draftId:d.id,startedAt:d.extractionStartedAt||d.createdAt,endedAt:d.extractionEndedAt,state:d.status==='transcribing'?'running':d.status==='needs-action'?'needs-action':'completed',running:d.status==='transcribing',stage:'source',label:d.message,visited:['source','assets']}:null;
    const audio=this.voice?.review(d.body),assets=d.assets.map(a=>({...a,preview:`fengsha-media://draft-${d.id}/${a.id}`}));
    const assetPairs=buildAssetPairs(assets,d.assetOrder,a=>!!a.file&&fs.existsSync(a.file));
    let remixSummary=d.remixSummary,message=d.message;
    if(remixSummary?.status==='completed'&&remixSummary.scope!=='text'){
      const generated=assetPairs.filter(p=>p.status==='generated').length;
      if(generated<remixSummary.images.total||assetPairs.some(p=>p.status!=='generated')){remixSummary={...remixSummary,status:'partial',images:{...remixSummary.images,generated}};message='部分二创图片缺失或未生成，尚未全部完成；原始素材保留。';}
    }
    return {...d,message,remixSummary,assetPairs,extractionProgress,videoCurrent:!!d.videoFile&&d.videoRevision===d.revision&&(!audio||d.videoAudioHash===audio.hash),voiceReview:audio?{...audio,approved:d.voiceApproval?.hash===audio.hash,audioReady:d.generatedAudioHash===audio.audioHash&&!!d.generatedAudioFile&&fs.existsSync(d.generatedAudioFile),preview:`fengsha-media://draft-${d.id}/audio`}:null,assets};
  }
  save(id,raw){const d=this.get(id);if(this.active||this.remixController)throw new Error('正在克隆或改图，请等待完成');if(raw.revision!==d.revision)throw new Error('稿件已更新，请重新读取后编辑');
    const title=safeTitle(raw.title),body=typeof raw.body==='string'?raw.body:'';
    if(!title||body.length>200000)throw new Error('标题不能为空，正文不能超过 20 万字');
    const assets=raw.assetIds;if(!Array.isArray(assets)||assets.length>50||new Set(assets).size!==assets.length||assets.some(id=>!d.assets.some(a=>a.id===id)))throw new Error('素材排序无效，请重新读取稿件');
    const tags=typeof raw.tags==='string'?raw.tags.trim().slice(0,1000):'';const visibility=['public','private'].includes(raw.visibility)?raw.visibility:'public';
    const next={...d,title,body,tags,visibility,assetOrder:assets,revision:d.revision+1,updatedAt:Date.now()};delete next.extractionProgress;delete next.assets;delete next.voiceReview;delete next.videoCurrent;delete next.assetPairs;next.assets=d.assets.map(({preview,...a})=>a);
    this.store.put('content-draft',id,next);this.store.flush();this.changed();return this.get(id);
  }
  async exclusive(fn,remix=false){if(this.active||this.voice?.active||this.search.active||this.remixController&&!remix)throw new Error('正在搜索、克隆或改图，请等待当前操作结束');const c=this.active=remix?this.remixController:this.flow||new AbortController();this.changed();try{const result=await(this.pending=fn(c.signal));if(!this.flow&&!this.remixController)this.finish('completed','当前内容已保存');return result;}catch(e){this.finish(c.signal.aborted?'cancelled':'failed',c.signal.aborted?'已停止，已取得内容保留':e.message);throw e;}finally{this.active=null;this.pending=null;this.changed();}}
  async cancel(id){
    this.flow?.abort();this.active?.abort();this.remixController?.abort();this.browser.close();
    const drafts=id?[this.store.get('content-draft',id)]:this.store.list('content-draft');
    for(const raw of drafts){
      if(raw?.status!=='transcribing')continue;
      const d=this.get(raw.id);if(d.status!=='transcribing')continue;
      d.status='needs-action';d.extractionEndedAt=Date.now();d.message='已停止提取，已取得的原文和素材保留；可继续提取。';d.revision++;
      this.checkpoint(d);
      await this.transcriptions.action(d.transcriptionId,'cancel');
    }
    this.changed();
  }
  resumeTranscript(id){
    const d=this.get(id);if(d.status!=='needs-action'||!d.transcriptionId)throw Error('当前稿件无需继续提取');
    this.transcriptions.get(d.transcriptionId);
    d.status='transcribing';d.extractionStartedAt=Date.now();delete d.extractionEndedAt;d.revision++;this.checkpoint(d);
    return this.transcriptions.action(d.transcriptionId,'retry').then(()=>this.get(id));
  }
  async useCollected(id){
    if((this.active||this.flow||this.remixController)&&this.job?.draftId!==id)throw Error('正在处理其他稿件，请先停止或完成');
    const d=this.get(id);if(d.source.platform!=='视频号'||!d.source.text?.trim())throw Error('此作品没有已采集文案');
    if(d.status==='transcribing'){await this.cancel(id);}
    const current=this.get(id);current.original.description=current.source.text;current.original.text=current.source.text;current.originalTextKind='description';if(!current.body)current.body=current.source.text;current.status='draft';current.extractionEndedAt=Date.now();current.message='已使用采集的作品说明，口播提取可稍后单独进行。';current.revision++;this.checkpoint(current);return this.get(id);
  }
  extractTranscript(id){
    if(this.active||this.flow||this.remixController||this.search.active)throw Error('正在处理，请等待当前操作结束');
    const d=this.get(id);if(d.source.type!=='video'||d.status==='transcribing')throw Error('当前稿件无需开始提取');
    if(d.transcriptionId&&d.status==='needs-action')return this.resumeTranscript(id);
    const media=this.store.list('media').find(m=>m.platform===d.source.platform&&(m.sourceId===d.source.id||m.url===d.source.url)&&m.filePath&&fs.existsSync(m.filePath));
    const file=d.originalVideoFile&&fs.existsSync(d.originalVideoFile)?d.originalVideoFile:media?.filePath;
    const input=file?this.transcriptions.choose(file):null,t=this.transcriptions.start(input?{inputId:input.id}:{url:d.source.url,title:d.title});
    d.original.description=d.original.description||d.original.text;d.originalTextKind='transcript';d.transcriptionId=t.id;d.extractionStartedAt=Date.now();delete d.extractionEndedAt;d.status='transcribing';d.message=file?'正在从已有本地视频提取口播，不重复下载':'正在按需取得音轨并提取口播，已采集的作品说明保留。';d.revision++;this.checkpoint(d);return this.get(id);
  }
  async close(){await this.cancel();await this.pending?.catch(()=>{});this.browser.close();}
  async autoRemix(id,bin,instructions=''){
    if(!this.ai.config('text').hasKey&&!this.ai.config('image').hasKey){const d=this.get(id);d.message='二创未执行，原稿已保存。请先配置文本或图片服务，再点击“整篇 AI 二创”。';d.remixSummary={status:'partial',text:{status:'not-configured'},images:{total:d.assetOrder.length,generated:0,generatedAssetIds:[],status:'not-configured',missingOriginals:0}};this.checkpoint(d);return this.get(id);}
    await this.exclusive(async signal=>{let d=this.get(id);while(d.status==='transcribing'){signal.throwIfAborted();await delay(1000,undefined,{signal});d=this.get(id);}if(d.status!=='draft')throw new Error(d.message||'请先完成视频转录');});
    if(this.get(id).source.type==='video'&&this.get(id).originalVideoFile)await this.videoFrames(id,bin);
    const result=await this.remix(id,instructions);
    if(result.source.type==='video'&&this.voice?.config().source==='doubao'&&this.voice.config().execution==='automatic')return this.generateVoice(id);
    return result;
  }
  reviewVoice(id){const d=this.get(id);if(d.status!=='draft')throw Error('请先完成正文提取');return {...this.voice.review(d.body),approved:d.voiceApproval?.hash===this.voice.review(d.body).hash};}
  approveVoice(id,hash){if(this.active||this.remixController||this.voice?.active)throw Error('正在生成素材，请等待完成');const d=this.get(id),review=this.reviewVoice(id);if(hash!==review.hash)throw Error('正文或音色已改变，请重新核对');d.voiceApproval={hash,at:Date.now()};this.store.put('content-draft',id,d);this.store.flush();this.changed();return this.get(id);}
  async audioFor(d,signal){if(!this.voice||this.voice.config().source!=='doubao')return null;const review=this.voice.review(d.body);
    if(review.execution==='confirm'&&d.voiceApproval?.hash!==review.hash)throw Object.assign(Error('请先确认二创正文和音色，再生成豆包配音'),{code:'VOICE_CONFIRM_REQUIRED'});
    if(d.generatedAudioHash===review.audioHash&&d.generatedAudioFile&&fs.existsSync(d.generatedAudioFile))return d.generatedAudioFile;
    const file=path.join(this.directory,d.id,randomUUID()+'.mp3');await this.voice.synthesize(d.body,file,signal);signal.throwIfAborted();const current=this.get(d.id);
    if(current.revision!==d.revision||this.voice.review(current.body).hash!==review.hash)throw Error('合成期间正文或音色已改变，未采用过期配音');
    current.generatedAudioFile=file;current.generatedAudioHash=review.audioHash;current.message='豆包配音已生成，原声音保留，可试听。';this.store.put('content-draft',d.id,current);this.store.flush();this.changed();return file;
  }
  generateVoice(id){return this.exclusive(async signal=>{const d=this.get(id);if(d.status!=='draft')throw Error('请先完成正文');if(!this.voice||this.voice.config().source!=='doubao')throw Error('声音设置当前选择保留原声，无需生成配音');await this.audioFor(d,signal);return this.get(id);});}
  audioAsset(id){const d=this.get(id),r=this.voice?.review(d.body);if(!r||d.generatedAudioHash!==r.audioHash||!d.generatedAudioFile||!fs.existsSync(d.generatedAudioFile))throw Error('当前正文尚未生成对应配音');const rel=path.relative(fs.realpathSync(this.directory),fs.realpathSync(d.generatedAudioFile));if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('配音文件位置无效');return d.generatedAudioFile;}
  async originalMedia(d,signal){
    if(d.originalVideoFile&&fs.existsSync(d.originalVideoFile))return d.originalVideoFile;
    const saved=d.transcriptionId?this.store.get('transcription',d.transcriptionId)?.sourceFile:null;
    if(saved&&/\.(mp4|mkv|webm|mov)$/i.test(saved)&&fs.existsSync(saved)){const current=this.get(d.id);current.originalVideoFile=saved;this.checkpoint(current);return saved;}
    const engine=this.transcriptions.engine,group=await engine.parse(d.source.url,{limit:1,signal,allowCollector:false}),item=group.items[0];
    if(!item)throw new Error('尚未取得原视频，请检查登录或原链接');
    const media=await engine.download({id:d.id,item:{...item,key:item.key||mediaKey(item)},options:{quality:'best',allowCollector:false}},path.join(this.directory,d.id,'原视频'),signal,()=>{});
    const current=this.get(d.id);current.originalVideoFile=media.filePath;this.store.put('content-draft',d.id,current);this.store.flush();return media.filePath;
  }
  async videoFrames(id,bin){return this.exclusive(async signal=>{
    const d=this.get(id);if(d.source.type!=='video'||d.videoFramesReady)return d;
    fs.mkdirSync(path.join(this.directory,id),{recursive:true});
    const file=await this.originalMedia(d,signal),probe=JSON.parse(await command(path.join(bin,'ffmpeg','ffprobe.exe'),['-v','error','-show_format','-show_streams','-of','json',file],{signal}));
    const duration=Number(probe.format?.duration);if(!probe.streams?.some(s=>s.codec_type==='video')||!Number.isFinite(duration)||duration<=0||duration>7200)throw new Error('原视频没有有效画面，或超过两小时');
    const frames=[],count=Math.min(8,Math.max(1,Math.ceil(duration/10)));for(let i=0;i<count;i++){
      this.step(id,'frames',`正在提取关键画面 ${i+1} / ${count}`,{current:i,total:count});signal.throwIfAborted();const assetId=randomUUID(),target=path.join(this.directory,id,assetId+'.png'),at=Math.max(0,Math.min(duration-.05,duration*(i+.5)/count));
      await command(path.join(bin,'ffmpeg','ffmpeg.exe'),['-hide_banner','-loglevel','error','-ss',String(Math.max(0,at)),'-i',file,'-frames:v','1','-vf','scale=1080:1080:force_original_aspect_ratio=decrease',target],{signal,timeout:60000});
      if(nativeImage.createFromPath(target).isEmpty())throw new Error('关键画面提取失败，原素材保留');frames.push({id:assetId,file:target,kind:'image',origin:'original',source:d.source.url,sourceTime:at});const partial=this.get(id);partial.assets.push(frames.at(-1));partial.assetOrder=frames.map(a=>a.id);partial.revision++;partial.message=`已提取关键画面 ${i+1} / ${count}`;this.checkpoint(partial);
    }
    const current=this.get(id);current.assetOrder=frames.map(a=>a.id);current.videoFramesReady=true;current.revision++;current.message='已从原视频提取关键画面，可逐张二创；原视频及封面保留。';this.store.put('content-draft',id,current);this.store.flush();this.changed();return this.get(id);
  });}
  async clone(recordId,itemId){return this.exclusive(async signal=>{
    const found=this.search.item(recordId,itemId);let item=found.item;
    const id=randomUUID(),dir=path.join(this.directory,id);fs.mkdirSync(dir);
    const draft={id,searchRecordId:recordId,source:{...item},original:{title:item.title,text:item.text||'',images:item.images||[]},title:item.title,body:item.type==='image'?item.text||'':'',tags:'',visibility:'public',assets:[],assetOrder:[],revision:1,status:'cloning',createdAt:Date.now(),message:'正在取得原作品正文…'};
    this.store.put('meta','lastContentDraft',{id});this.step(id,'source','正在读取原作品正文');this.checkpoint(draft);
    try{
      if(item.type==='image'&&(!item.bodyComplete||!item.images.length)){const detail=await this.browser.detail(item,found.accountId,signal);item={...item,...detail,publishedAt:detail.publishedAt||item.publishedAt};}
      signal.throwIfAborted();if(item.type==='image'&&!item.text)throw new Error('该笔记尚未返回正文，不能把标题当作完整内容克隆');
      Object.assign(draft,{source:{...item},original:{title:item.title,text:item.text||'',images:item.images},body:item.type==='image'?item.text:''});this.checkpoint(draft);
      const urls=item.images.length?item.images:item.thumbnail?[item.thumbnail]:[];const problems=[];
      this.step(id,'assets','正在逐张保存原作品画面',{current:0,total:urls.length});
      for(const url of urls){signal.throwIfAborted();try{const bytes=await assetBytes(url,this.fetcher,signal);const assetId=randomUUID(),file=path.join(dir,assetId+'.png');await this.writeImage(bytes,file,signal);signal.throwIfAborted();draft.assets.push({id:assetId,file,kind:'image',source:url,origin:'original'});draft.assetOrder.push(assetId);draft.revision++;this.checkpoint(draft);}catch(e){if(signal.aborted)throw e;problems.push(e.message);}this.job.current++;this.job.label=`正在保存原画面 ${this.job.current} / ${urls.length}`;this.changed();}
      if(item.platform==='视频号'&&item.type==='video'&&item.text?.trim()){draft.body=item.text;draft.original.description=item.text;draft.originalTextKind='description';draft.status='draft';draft.message='已复用采集的作品说明与封面，可直接二创；需要视频口播时再单独提取，不自动下载原视频。';}
      else if(item.type==='video'){const t=this.transcriptions.start({url:item.url,title:item.title});draft.transcriptionId=t.id;draft.extractionStartedAt=Date.now();draft.status='transcribing';draft.message='正在提取视频口播文字；画面素材与文案分别保留。';this.step(id,'transcript','正在提取视频口播文字');}
      else{draft.status='draft';draft.message=problems.length?`${problems.length} 张图片未取得，可添加自己的图片；原始素材链接保留。`:'已克隆正文和图片，可进行二创修改。';}
      if(problems.length)draft.assetWarnings=problems;draft.revision++;this.checkpoint(draft);return this.get(id);
    }catch(e){draft.status='needs-action';draft.message=signal.aborted?'克隆已停止，已取得正文和图片保留；可重新克隆原作品':e.message;this.checkpoint(draft);throw e;}
    finally{this.browser.close();}
  });}
  async writeImage(bytes,file,signal){const image=nativeImage.createFromBuffer(bytes);if(!image.isEmpty()){fs.writeFileSync(file,image.toPNG());return;}
    if(bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WEBP')throw Error('素材不是可读取的图片');
    const input=file+'.webp';try{fs.writeFileSync(input,bytes);await command(path.join(this.transcriptions.engine.bin,'ffmpeg','ffmpeg.exe'),['-hide_banner','-loglevel','error','-i',input,'-frames:v','1',file],{signal,timeout:30000});if(nativeImage.createFromPath(file).isEmpty())throw Error('WebP 图片转换后校验失败');}finally{try{fs.unlinkSync(input);}catch{}}
  }
  async rewrite(id,instructions='',remix=false,options={}){return this.exclusive(async signal=>{const d=this.get(id),sourceText=options.reference==='current'?d.body:d.original.text,sourceTitle=options.reference==='current'?d.title:d.original.title;if(d.status!=='draft'||!sourceText.trim())throw new Error('请先完成原始文字提取');
    if(sourceText.length>30000)throw new Error('原文超过三万字，请先在转录页面分段处理');
    this.step(id,'rewrite','AI 正在生成新的文案',{preview:{}});const response=await this.ai.chat(textRemixSystemPrompt,JSON.stringify({sourceTitle,sourceText,reference:options.reference||'original',instructions:String(instructions).slice(0,4000)}),signal,value=>{if(signal.aborted)return;this.job.preview=draftTextPreview(value);this.changed();});
    let result;try{result=JSON.parse(response.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new Error('文本模型未返回完整二创稿，原内容保留');}
    try{result=normalizeRemixResult(result,{sourceText,instructions});}catch(e){if(e.reviewNotes?.length){const current=this.get(id);if(current.revision===d.revision){current.reviewNotes=e.reviewNotes;this.checkpoint(current);}}throw e;}
    signal.throwIfAborted();const current=this.get(id);if(current.revision!==d.revision)throw new Error('生成期间稿件已修改，请重新操作');
    current.history=[...(current.history||[]),{title:d.title,body:d.body,tags:d.tags,reviewNotes:d.reviewNotes||[],at:Date.now()}].slice(-20);current.title=safeTitle(result.title);current.body=result.body;current.tags=result.tags;current.reviewNotes=result.reviewNotes;current.revision++;current.message='已生成独立二创文案，原文和审阅意见分别保留，请核对内容后发布。';this.store.put('content-draft',id,current);this.store.flush();this.changed();return this.get(id);
  },remix);}
  async remix(id,instructions='',options={}){
    const scope=options.scope||'all',reference=options.reference||'original';
    if(!['all','text','images'].includes(scope))throw new Error('二创范围无效');
    if(!['original','current'].includes(reference))throw new Error('二创参考内容无效');
    if(!['preserve','redesign'].includes(options.mode||'preserve'))throw new Error('图片编辑方式无效');
    const useText=scope!=='images',useImages=scope!=='text';
    if(this.active||this.remixController||this.search.active)throw new Error('正在处理其他任务，请等待完成');
    const before=this.get(id),text=this.ai.config('text'),images=this.ai.config('image');
    if(!(useText&&text.hasKey)&&!(useImages&&images.hasKey))throw new Error('请先在 AI 设置配置文本或图片服务；克隆原稿已保存');
    const summary={status:'running',scope,reference,text:{status:!useText?'unchanged':text.hasKey&&text.model?'pending':'not-configured'},images:{total:useImages?before.assetOrder.length:0,generated:0,generatedAssetIds:[],status:!useImages?'unchanged':before.assetOrder.length?(images.hasKey&&images.model?'pending':'not-configured'):'not-needed',missingOriginals:useImages&&before.source.type==='image'?Math.max(0,(before.original.images?.length||0)-before.assets.filter(a=>a.origin==='original').length):0}};
    const saveSummary=()=>{const d=this.get(id);d.remixSummary=structuredClone(summary);d.message=summary.status==='completed'?(scope==='text'?'文案优化已保存，图片保持不变。':scope==='images'?'图片优化已保存，文案保持不变。':'二创文案与画面已保存，原稿保留，请审阅生成结果。'):`二创尚未全部完成：文案${summary.text.status==='generated'?'已生成':'未完成'}，图片 ${summary.images.generated} / ${summary.images.total}${summary.images.missingOriginals?'，部分原图未取得':''}；已有结果和原始素材保留。`;this.checkpoint(d);};
    this.remixController=this.flow||new AbortController();this.step(id,useText?'rewrite':'image',`正在准备${scope==='text'?'文案优化':scope==='images'?'图片优化':'文案与图片二创'}`);saveSummary();
    try{if(useText&&text.hasKey&&text.model){await this.rewrite(id,instructions,true,{reference});summary.text.status='generated';saveSummary();}
      if(useImages&&images.hasKey&&images.model){for(const [i,assetId] of before.assetOrder.entries()){this.step(id,'image',`AI 正在调整画面 ${i+1} / ${before.assetOrder.length}`,{current:i+1,total:before.assetOrder.length,preview:null});this.remixController.signal.throwIfAborted();const result=await this.editImage(id,assetId,instructions||'尽量保持原图风格和排版，只做局部优化，不增加文字。',true,{reference,mode:options.mode||'preserve'});const generated=result.assets.at(-1);summary.images.generated++;summary.images.generatedAssetIds.push(generated.id);saveSummary();}if(before.assetOrder.length)summary.images.status='generated';}
      this.remixController.signal.throwIfAborted();summary.status=(!useText||summary.text.status==='generated')&&(!useImages||summary.images.generated===summary.images.total&&!summary.images.missingOriginals)?'completed':'partial';saveSummary();
      if(!this.flow)this.finish(summary.status==='completed'?'completed':'needs-action',this.get(id).message);return this.get(id);
    }catch(e){summary.status='partial';if(summary.text.status==='pending')summary.text.status='failed';if(summary.images.status==='pending')summary.images.status='incomplete';saveSummary();throw e;
    }finally{this.remixController=null;this.changed();}
  }
  asset(id,assetId){const d=this.get(id),a=d.assets.find(a=>a.id===assetId);if(!a||!fs.existsSync(a.file))throw new Error('图片素材已不存在');const root=fs.realpathSync(this.directory),file=fs.realpathSync(a.file);if(path.relative(root,file).startsWith('..')||path.isAbsolute(path.relative(root,file)))throw new Error('图片素材位置无效');return a;}
  add(id,files){if(this.active||this.remixController)throw new Error('请等待当前任务结束');const d=this.get(id);if(d.assets.length+files.length>50)throw new Error('每篇最多保存 50 张图片');
    const additions=files.map(file=>{if(fs.statSync(file).size>30*1024*1024)throw new Error('图片超过 30MB');const image=nativeImage.createFromPath(file);if(image.isEmpty())throw new Error('请选择 PNG、JPG 或 WebP 图片');return {id:randomUUID(),bytes:image.toPNG()};});
    for(const a of additions){const file=path.join(this.directory,id,a.id+'.png');fs.writeFileSync(file,a.bytes);d.assets.push({id:a.id,file,kind:'image',origin:'imported'});d.assetOrder.push(a.id);}d.revision++;this.store.put('content-draft',id,d);this.store.flush();this.changed();return this.get(id);
  }
  async editImage(id,assetId,prompt,remix=false,options={}){if(typeof prompt!=='string'||!cleanImageInstructions(prompt)||prompt.length>32000)throw new Error('请输入图片修改要求（最多 32000 字）');prompt=cleanImageInstructions(prompt);if(!['original','current'].includes(options.reference||'original')||!['preserve','redesign'].includes(options.mode||'preserve'))throw new Error('图片编辑方式无效');return this.exclusive(async signal=>{
    this.step(id,'image','AI 正在重绘当前画面');const d=this.get(id),a=this.asset(id,assetId),c=this.ai.config('image');const key=this.ai.secret('image',c.baseUrl);
    if(!key||!c.model)throw new Error('请先在 AI 设置保存图片服务密钥和 GPT Image 2.5 模型');
    const lineage=resolveAssetLineage(d.assets,assetId);if(!lineage.valid)throw new Error('原图关联缺失或循环，不能可靠追溯；原素材保留');
    const base=options.reference==='current'?a:this.asset(id,lineage.originalAssetId),dimensions=nativeImage.createFromPath?.(base.file)?.getSize?.()||{};
    const size=dimensions.height>dimensions.width*1.2?'1024x1536':dimensions.width>dimensions.height*1.2?'1536x1024':'1024x1024';
    const policyPrompt=imageRemixPrompt(prompt,{title:d.title,mode:options.mode});const form=new FormData();form.set('model',c.model);form.set('prompt',policyPrompt);form.set('image',new Blob([fs.readFileSync(base.file)],{type:'image/png'}),'source.png');form.set('output_format','png');form.set('size',size);
    const response=await this.fetcher(apiBase(c.baseUrl)+'/images/edits',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(c.timeout*1000)])});
    if(!response.ok)throw new Error(response.status>=500?`CPA 图片上游暂不可用（HTTP ${response.status}），请在设置中选择 CPA 可用的 GPT Image 2.5 型号后重试；原图保留`:`图片模型未完成修改（HTTP ${response.status}），请检查服务、模型权限或额度；原图保留`);
    const raw=await response.text();if(raw.length>64*1024*1024)throw new Error('图片模型响应过大');let payload;try{payload=JSON.parse(raw);}catch{throw new Error('图片服务返回了无效响应');}
    const base64=payload.data?.[0]?.b64_json;if(typeof base64!=='string'||!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(base64)||base64.length>48*1024*1024)throw new Error('图片服务未返回有效的 base64 图片，请检查 Images Edits 兼容性');
    const bytes=Buffer.from(base64,'base64'),image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())throw new Error('模型返回的图片无法读取，原图保留');signal.throwIfAborted();
    const current=this.get(id);if(current.revision!==d.revision)throw new Error('改图期间稿件已改变，请重新操作；原图保留');
    const newId=randomUUID(),file=path.join(this.directory,id,newId+'.png');fs.writeFileSync(file,image.toPNG());
    current.assets.push({id:newId,file,kind:'image',origin:'generated',originalAssetId:base.id,replacesAssetId:assetId,editMode:options.mode||'preserve',reference:options.reference||'original',size,model:c.model,prompt,policyPrompt});current.assetOrder=current.assetOrder.map(v=>v===assetId?newId:v);current.revision++;current.message='图片调整已保存，原图与历史版本保留，请放大对比检查。';this.store.put('content-draft',id,current);this.store.flush();this.changed();return this.get(id);
  },remix);}
  async renderVideo(id,bin){return this.exclusive(async signal=>{const d=this.get(id);if(d.status!=='draft'||!d.assetOrder.length)throw new Error('请先完成文字提取并添加至少一张画面图片');
    const selectedAudio=this.voice?.review(d.body),doubao=selectedAudio?.source==='doubao';
    const t=d.transcriptionId?this.store.get('transcription',d.transcriptionId):null;let audio=doubao?await this.audioFor(d,signal):t?.sourceFile;
    if(!doubao&&d.source.type==='video'&&(!audio||/\.(vtt|srt)$/i.test(audio))){
      audio=await this.originalMedia(d,signal);
    }
    if(d.source.type==='video'&&(!audio||!fs.existsSync(audio)))throw new Error('原视频音频尚未取得，请先完成转录');
    let duration=d.assetOrder.length*3;
    if(audio){const info=JSON.parse(await command(path.join(bin,'ffmpeg','ffprobe.exe'),['-v','error','-show_format','-show_streams','-of','json',audio],{signal}));duration=Number(info.format?.duration);if(!Number.isFinite(duration)||duration<=0||duration>7200)throw new Error('音频时长无效或超过两小时');if(!info.streams?.some(s=>s.codec_type==='audio'))audio=null;}
    const dir=path.join(this.directory,id),token=randomUUID(),list=path.join(dir,token+'.ffconcat');const source=d.assetOrder.map(assetId=>this.asset(id,assetId));
    // These are application-created UUID paths, never renderer-supplied filenames.
    const quote=f=>f.replaceAll('\\','/').replaceAll("'","'\\''");
    fs.writeFileSync(list,'ffconcat version 1.0\n'+source.map(a=>`file '${quote(a.file)}'\nduration ${duration/source.length}\n`).join('')+`file '${quote(source.at(-1).file)}'\n`);
    const file=path.join(dir,token+'.mp4'),args=['-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list];if(audio)args.push('-i',audio);
    args.push('-vf','scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=white,fps=25','-r','25','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p');
    if(audio)args.push('-map','0:v:0','-map','1:a:0','-c:a','aac');args.push('-t',String(duration),'-movflags','+faststart',file);
    await command(path.join(bin,'ffmpeg','ffmpeg.exe'),args,{signal,timeout:3600000});signal.throwIfAborted();const info=JSON.parse(await command(path.join(bin,'ffmpeg','ffprobe.exe'),['-v','error','-show_streams','-show_format','-of','json',file],{signal}));if(!info.streams?.some(s=>s.codec_type==='video')||Math.abs(Number(info.format?.duration)-duration)>.2||!Number.isFinite(Number(info.format?.duration)))throw new Error('发布视频画面或时长校验失败，原素材保留');
    const current=this.get(id);if(current.revision!==d.revision||selectedAudio&&this.voice.review(current.body).hash!==selectedAudio.hash)throw new Error('生成期间稿件或声音设置已更新，请重新生成');current.videoFile=file;current.videoRevision=d.revision;current.videoAudioHash=selectedAudio?.hash;this.store.put('content-draft',id,current);this.store.flush();this.changed();return this.get(id);
  });}
  export(id){const d=this.get(id),dir=path.join(this.directory,id,'发布素材-'+d.revision);fs.mkdirSync(dir,{recursive:true});const files=[];
    for(const [i,assetId] of d.assetOrder.entries()){const a=this.asset(id,assetId),file=path.join(dir,`${String(i+1).padStart(2,'0')}.png`);fs.copyFileSync(a.file,file);files.push(file);}
    let videoFile=null;if(d.videoCurrent&&fs.existsSync(d.videoFile)){videoFile=path.join(dir,'发布视频.mp4');fs.copyFileSync(d.videoFile,videoFile);}
    const text=`${d.title}\n\n${d.body}\n\n${d.tags}`;fs.writeFileSync(path.join(dir,'正文.txt'),text,'utf8');fs.writeFileSync(path.join(dir,'来源.json'),JSON.stringify({url:d.source.url,author:d.source.author,platform:d.source.platform,publishedAt:d.source.publishedAt},null,2),'utf8');return {directory:dir,files,videoFile,text,title:d.title,body:d.body,tags:d.tags,visibility:d.visibility};
  }
}
