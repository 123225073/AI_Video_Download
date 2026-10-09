import React,{useEffect,useState} from 'react';
import {Sparkles,Check,Clock,Square,AlertCircle,ArrowLeft} from 'lucide-react';
const stages=[['source','原文'],['assets','素材'],['rewrite','文案'],['image','画面']];
export default function StudioProgress({job,busy,source,onBack,onStop}){
  const [now,setNow]=useState(Date.now());useEffect(()=>{if(!busy)return;const t=setInterval(()=>setNow(Date.now()),250);return()=>clearInterval(t);},[busy]);
  const seconds=Math.floor(Math.max(0,(busy?now:job?.endedAt||now)-(job?.startedAt||now))/1000),time=`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
  const state=job?.state||'running',failed=['failed','cancelled'].includes(state),stage=stages.findIndex(([k])=>k===job?.stage);
  return <section className={`studio-progress ${busy?'is-running':''} ${failed?'is-failed':''}`} aria-label="克隆处理进度" aria-live="polite">
    <div className="studio-progress-top"><button className="studio-back" onClick={onBack}><ArrowLeft size={17}/>返回搜索</button><span className="studio-session">独立二创工作台</span><span className="studio-clock"><Clock size={15}/>{busy?'已等待':'处理用时'} <b data-testid="studio-elapsed">{time}</b></span>{busy&&<button className="studio-stop" onClick={onStop}><Square size={12}/>停止处理</button>}</div>
    <div className="studio-progress-main"><div className="studio-orbit">{failed?<AlertCircle size={28}/>:busy?<Sparkles size={30}/>:<Check size={30}/>}<i/><i/></div><div><h2>{busy?(job?.label||'正在准备克隆工作台…'):failed?(job?.label||'当前处理已停止'):'内容已保存，开始创作吧'}</h2><p>{source?.title||'正在读取所选作品'}{job?.total>0&&busy?` · 当前 ${job.current||0} / ${job.total}`:''}</p><small>{busy?'取得的正文和画面会逐步显示；AI 文案生成中为预览，完成并校验后保存。':'原文和原素材保留。可以编辑内容，也可以返回搜索继续选择作品。'}</small></div></div>
    <div className="studio-stages">{stages.map(([id,label],i)=>{const done=job?.visited?.includes(id)&&(!busy&&!failed||id!==job.stage);return <span key={id} className={done?'done':i===stage?'current':''}><i>{done?<Check size={12}/>:i+1}</i>{label}{!busy&&!failed&&!done&&<small>未执行</small>}</span>;})}</div>
  </section>;
}
