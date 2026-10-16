import React,{useState,useEffect,useRef} from 'react';

export default function ArticlePrompts({article,busy,onAction,onDirtyChange,onImages,settings}){
  const [editing,setEditing]=useState(null),[dirty,setDirty]=useState(false),[confirm,setConfirm]=useState(false);
  const dirtyRef=useRef(false);dirtyRef.current=dirty;
  useEffect(()=>{if(!dirtyRef.current)setEditing(article?{draftId:article.draftId,promptRevision:article.promptRevision||0,imageStyle:article.imageStyle||'',pages:article.pages.map(p=>({id:p.id,generationPrompt:p.generationPrompt||''}))}:null);},[article?.draftId,article?.promptRevision]);
  useEffect(()=>{onDirtyChange(dirty);return()=>onDirtyChange(false);},[dirty]);
  if(!article)return <div className="video-article-output-empty"><b>先完成图文方案</b><p>方案通过校验后，会自动转换为可编辑的生图提示词。中断的候选请先在“视频转图文”中继续处理。</p></div>;
  const ready=article.pages.every(p=>p.generationPrompt),binding={draftId:article.draftId,promptRevision:article.promptRevision||0};
  const change=update=>{setEditing(update);setDirty(true);};
  const pending=article.pages.filter(p=>!p.imageCurrent).length;
  return <div className="article-prompts">
    <div className="video-article-intro"><b>先核对提示词，再批量生成配图</b><p>每页提示词包含主题、画面、构图、文字和约束；整组共用下面的统一画风。修改后先保存，已完成且提示词未变的图片会直接复用。</p></div>
    {!ready?<button className="button primary" disabled={busy} onClick={()=>onAction('article-prompts-save',binding)}>转换为生图提示词</button>:editing&&<>
      <label className="article-style-label">整组统一画风<textarea aria-label="整组统一画风" disabled={busy} value={editing.imageStyle} onChange={e=>change({...editing,imageStyle:e.target.value})}/></label>
      <div className="article-prompt-actions"><button className="button primary" disabled={busy||!dirty} onClick={async()=>{const r=await onAction('article-prompts-save',editing);if(r){setDirty(false);setEditing({...editing,promptRevision:r.article.promptRevision});}}}>保存生图提示词</button><button className="button" disabled={busy||dirty||pending===0||article.bodyEdited} onClick={()=>setConfirm(true)}>{article.generatedCount?'继续生成剩余 / 已修改配图':'批量生成配图'}（{pending} 张）</button><button className="text-button" onClick={()=>settings?.('ai')}>图片模型设置</button><span>{dirty?'有未保存修改':'提示词已保存'} · 已有 {article.generatedCount||0} 张配图</span></div>
      {article.bodyEdited&&<p className="video-review-note">图文正文已在编辑器修改，请重新创作分页方案后再生图，避免使用旧分页。</p>}
      <div className="article-prompt-list">{article.pages.map((p,i)=><article key={p.id}><div className="video-section-title"><b>{String(i+1).padStart(2,'0')} · {p.title}</b><span>{p.imageCurrent?'配图已完成':p.preview?'提示词已修改，待重新生成':'待生成'}</span></div><details><summary>本页文案与原配图方案</summary><p>{p.text}</p><p>{p.imagePrompt}</p></details><textarea aria-label={`第 ${i+1} 页生图提示词`} disabled={busy} value={editing.pages.find(v=>v.id===p.id)?.generationPrompt||''} onChange={e=>change({...editing,pages:editing.pages.map(v=>v.id===p.id?{...v,generationPrompt:e.target.value}:v)})}/>{p.preview&&<img src={p.preview} alt={`第 ${i+1} 页配图`}/>}</article>)}</div>
      <button className="button" disabled={busy||dirty} onClick={()=>onImages(article.draftId)}>打开图文成稿继续编辑与导出</button>
    </>}
    {confirm&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="确认批量生成配图"><h2>生成 {pending} 张配图</h2><p>使用已配置的图片模型和已保存的提示词，可能产生费用。每张成功图片立即保存；中断后可继续，已完成且提示词相同的图片不会重复生成。</p><div className="modal-actions"><button autoFocus className="button" onClick={()=>setConfirm(false)}>返回编辑</button><button className="button primary" onClick={()=>{setConfirm(false);onAction('article-images',binding);}}>确认生成</button></div></section></div>}
  </div>;
}
