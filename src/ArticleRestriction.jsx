import React,{useEffect,useState,useId} from 'react';
import {X} from 'lucide-react';

export default function ArticleRestriction({record,now,busy,onOfficial,onLinks}){
 const restricted=record?.action==='wechat-rate-limit',key=restricted?`${record.id}:${record.restriction?.retryAt||0}`:null;
 const [open,setOpen]=useState(false),description=useId();
 useEffect(()=>{setOpen(!!key);},[key]);
 if(!restricted)return null;
 const seconds=Math.max(0,Math.ceil(((record.restriction?.retryAt||0)-now)/1000)),remaining=`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
 return <>
  <div className="article-restriction" role="status"><div><strong>微信暂时限制了公众号文章列表读取</strong><p>{seconds?`本机暂停请求，剩余 ${remaining}。`:'本机暂停已结束，可手动继续；微信是否恢复以实际返回为准。'}已有账号、清单和读取位置已保留。</p></div><button className="button" onClick={()=>setOpen(true)}>查看处理指引</button></div>
  {open&&<div className="modal-backdrop" onClick={()=>setOpen(false)}><section className="modal article-restriction-dialog" role="dialog" aria-modal="true" aria-label="公众号文章列表访问受限" aria-describedby={description} onClick={e=>e.stopPropagation()}>
   <div className="modal-head"><h2>微信暂时不提供该账号的文章列表</h2><button className="icon-button" aria-label="关闭处理指引" onClick={()=>setOpen(false)}><X/></button></div>
   <div id={description}><p>公众号身份已经识别，但微信拒绝了当前登录会话的文章列表请求。这不表示公众号没有文章。</p><p>{seconds?`为避免继续触发限制，本机暂停 ${remaining}，期间不会自动请求。`:'本机暂停已结束，可关闭提示后点击“继续读取列表”。'}本机暂停时间不是微信承诺的恢复时间。</p><ol><li>稍后再手动继续读取，已有文章和分页位置会保留。</li><li>可查看微信官方页面，确认当前账号状态；仅收到此限制不需要反复扫码。</li><li>已有文章链接或公开合集可以使用对应入口读取，结果范围以你提供的链接为准。</li></ol></div>
   <details><summary>查看返回信息</summary><p>微信返回：{record.restriction?.platformCode||'200013'}。无法仅凭该代码确定是短时频控还是账号、平台规则限制。</p></details>
   <div className="article-actions"><button className="button primary" onClick={()=>setOpen(false)}>稍后处理，保留清单</button><button className="button" disabled={busy} onClick={onLinks}>使用文章链接采集</button><button className="button" disabled={busy} onClick={onOfficial}>查看微信官方页面</button></div>
  </section></div>}
 </>;
}
