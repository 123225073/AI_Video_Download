import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {generatePage} from './video-article.js';
import {promptHash} from './article-prompts.js';

// A user-triggered batch; checkpoint each successfully decoded image. Existing
// matching images are reused, and no failed paid request is automatically retried.
export async function generateArticleImages({article,ai,directory,signal,onCheckpoint,onPreview,imageDecoder,fetcher}) {
  const result=structuredClone(article),config=ai.config('image');
  if(!config.hasKey||!config.model)throw Error('请先在设置中配置图片服务密钥和模型');
  if(!result.imageStyle?.trim()||result.pages.some(p=>!p.generationPrompt?.trim()))throw Error('请先保存统一画风和每页生图提示词');
  const request=fetcher||(typeof ai.fetch==='function'?ai.fetch.bind(ai):globalThis.fetch);
  for(const p of result.pages) {
    signal?.throwIfAborted();
    const hash=promptHash(result.imageStyle,p.generationPrompt);
    if(p.imageFile&&p.generatedPromptHash===hash&&await fs.stat(p.imageFile).then(s=>s.isFile(),()=>false))continue;
    onPreview?.({stage:'images',label:`正在生成配图 ${p.index} / ${result.pages.length}`,completed:result.pages.filter(v=>v.imageFile).length,total:result.pages.length});
    const bytes=await generatePage({ai,config,fetcher:request,imageDecoder,page:p,style:result.imageStyle,signal});
    signal?.throwIfAborted();
    await fs.mkdir(directory,{recursive:true});
    const file=path.join(directory,`${p.id}-${randomUUID()}.png`);
    await fs.writeFile(file,bytes,{flag:'wx'});
    p.imageFile=file;p.generatedPromptHash=hash;
    result.generatedCount=result.pages.filter(v=>v.imageFile).length;
    await onCheckpoint?.(structuredClone(result));
  }
  return result;
}
