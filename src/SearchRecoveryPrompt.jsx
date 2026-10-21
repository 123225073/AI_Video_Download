import React,{useEffect,useId,useRef,useState} from 'react';
import {ExternalLink,LoaderCircle,RefreshCw,X} from 'lucide-react';
import './search-recovery.css';

const titles={login:'需要完成平台登录',verification:'需要完成平台验证',network:'官方页面连接未完成',page:'需要检查官方页面'};
export default function SearchRecoveryPrompt({record,perform,automatic,onConsume,onResume,onDismiss,onAccounts}){
  const titleId=useId(),descriptionId=useId(),dialog=useRef(null),mounted=useRef(false),inFlight=useRef(false),continuing=useRef(false),lastCheck=useRef(0),attempts=useRef(0),deadline=useRef(0);
  const [working,setWorking]=useState(''),[message,setMessage]=useState(''),[monitor,setMonitor]=useState(automatic),[closed,setClosed]=useState(false);
  const latest=useRef({record,automatic,onConsume,onResume,onDismiss});latest.current={record,automatic,onConsume,onResume,onDismiss};
  useEffect(()=>{mounted.current=true;const previous=document.activeElement;dialog.current?.querySelector('button')?.focus();return()=>{mounted.current=false;if(previous?.isConnected)previous.focus();};},[]);
  useEffect(()=>{setMonitor(automatic);setClosed(false);setMessage('');attempts.current=0;deadline.current=Date.now()+120000;continuing.current=false;},[record.action.id,automatic]);
  async function resume(fromCheck=false){
    if(continuing.current||inFlight.current&&!fromCheck)return;
    continuing.current=true;setMonitor(false);latest.current.onConsume();setWorking('continue');
    try{await latest.current.onResume();}catch(error){if(mounted.current)setMessage(error.message);}
    finally{if(mounted.current)setWorking('');}
  }
  async function check(manual=false){
    if(inFlight.current||continuing.current||!mounted.current||!manual&&(!monitor||document.hidden||Date.now()-lastCheck.current<750))return;
    if(!manual&&(attempts.current>=45||Date.now()>=deadline.current)){setMonitor(false);setMessage('自动检测已暂停，条件和已有结果仍保留。完成官方页面操作后可点击检测继续。');return;}
    inFlight.current=true;lastCheck.current=Date.now();attempts.current++;setWorking('check');
    const id=latest.current.record.id,actionId=latest.current.record.action.id;
    try{
      const result=await perform('contentAction',id,'check');
      if(!mounted.current||latest.current.record.id!==id||latest.current.record.action.id!==actionId||result?.cancelled)return;
      if(result?.closed){setClosed(true);setMonitor(false);setMessage(result.message||'官方窗口已关闭。点击打开官方窗口后可继续。');}
      else if(result?.ready){await resume(true);}
      else if(result?.message)setMessage(result.message);
    }catch(error){if(mounted.current){setMonitor(false);setMessage(error.message);}}
    finally{inFlight.current=false;if(mounted.current)setWorking('');}
  }
  useEffect(()=>{
    if(!monitor)return;
    const checkOnReturn=()=>void check();
    const timer=setInterval(checkOnReturn,2000);window.addEventListener('focus',checkOnReturn);document.addEventListener('visibilitychange',checkOnReturn);
    return()=>{clearInterval(timer);window.removeEventListener('focus',checkOnReturn);document.removeEventListener('visibilitychange',checkOnReturn);};
  },[monitor,record.action.id]);
  async function open(){
    if(inFlight.current||continuing.current)return;
    inFlight.current=true;setWorking('open');setMessage('正在打开本次搜索的官方页面…');
    try{
      const result=await perform('contentAction',record.id,'open');
      if(!mounted.current||result?.cancelled)return;
      if(result?.manageAccount){onAccounts?.(record.platform);return;}
      setClosed(false);setMonitor(true);continuing.current=false;attempts.current=0;deadline.current=Date.now()+120000;
      setMessage(result?.message||'请在官方页面完成要求。返回这里后会自动检测，确认就绪后继续本次搜索。');
    }catch(error){if(mounted.current){setMonitor(false);setMessage(error.message);}}
    finally{inFlight.current=false;if(mounted.current)setWorking('');}
  }
  function dismiss(){setMonitor(false);latest.current.onConsume();latest.current.onDismiss();}
  function keyDown(event){
    if(event.key==='Escape'){event.preventDefault();dismiss();return;}
    if(event.key!=='Tab')return;
    const buttons=[...dialog.current.querySelectorAll('button:not(:disabled)')],first=buttons[0],last=buttons.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
  return <div className="search-recovery-backdrop"><section ref={dialog} className="search-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={keyDown}>
    <button className="search-recovery-close" aria-label="关闭搜索恢复提示" onClick={dismiss}><X size={20}/></button>
    <h2 id={titleId}>{titles[record.action.kind]||titles.page}</h2>
    <p id={descriptionId}>{record.action.message||record.message}</p>
    <p className="search-recovery-context">{record.platform} · “{record.keyword}” · 已保留 {record.items.length} 条作品，搜索条件和读取位置不变。</p>
    {record.action.kind==='network'?<ol><li>如果平台官网也无法打开，请确认当前网络允许访问该平台；公司网络限制需要由网络管理员处理。</li><li>网络恢复后，点击“重新连接并继续”；原搜索条件和已有作品会保留。</li></ol>:<ol><li>点击“{record.platform==='B站'?'去账号管理':'打开官方窗口'}”，在平台页面完成{record.action.kind==='login'?'登录':record.action.kind==='verification'?'验证':'页面提示的操作'}。</li><li>保持官方窗口打开，完成后返回下载器；软件检测就绪后继续原任务。</li></ol>}
    <p className="search-recovery-status" role="status">{message||(monitor?'正在自动检测官方页面，无需反复点击确认。':'已保留本次任务，可打开官方页面或手动检测后继续。')}</p>
    <div className="search-recovery-actions">
      <button className="button primary" disabled={!!working} onClick={open}>{working==='open'?<LoaderCircle className="spin" size={17}/>:<ExternalLink size={17}/>} {record.platform==='B站'?'去账号管理':'打开官方窗口'}</button>
      {(record.action.kind==='network'||closed)&&<button className="button" disabled={!!working} onClick={()=>resume()}><RefreshCw size={17}/>重新连接并继续</button>}
      <button className="button" disabled={!!working} onClick={()=>check(true)}>{working==='check'&&<LoaderCircle className="spin" size={17}/>}检测并继续</button>
      <button className="text-button" onClick={dismiss}>稍后处理，保留结果</button>
    </div>
  </section></div>;
}
