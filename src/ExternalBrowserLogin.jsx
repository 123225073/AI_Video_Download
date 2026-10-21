import React,{useEffect,useRef,useState} from 'react';
import {Check,ExternalLink,LoaderCircle,RotateCw} from 'lucide-react';
import './external-browser-login.css';

export function ExternalBrowserStatus({perform,accounts=[]}){
  const [status,setStatus]=useState(null),[checking,setChecking]=useState(false),[switching,setSwitching]=useState(false),[error,setError]=useState('');
  const mounted=useRef(false),pending=useRef(false),queued=useRef(false),epoch=useRef(0);
  const accountKey=accounts.map(a=>[a.id,a.status,a.loginBackend,a.lastSync].join(':')).join('|');
  async function refresh(){
    if(pending.current){queued.current=true;return;}
    pending.current=true;const current=++epoch.current;setChecking(true);setError('');
    try{const next=await perform('externalBrowserStatus');if(mounted.current&&current===epoch.current)setStatus(next);}
    catch(e){if(mounted.current&&current===epoch.current){setStatus(null);setError(e.message);}}
    finally{pending.current=false;if(mounted.current&&current===epoch.current)setChecking(false);if(queued.current&&mounted.current){queued.current=false;void refresh();}}
  }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
  useEffect(()=>{refresh();},[accountKey]);
  async function changeMode(mode){
    if(switching||pending.current)return;setSwitching(true);setError('');++epoch.current;
    try{const next=await perform('externalBrowserMode',mode);if(mounted.current){setStatus(next);window.dispatchEvent(new Event('fengsha-browser-mode-changed'));}}
    catch(e){if(mounted.current)setError(e.message);}
    finally{if(mounted.current)setSwitching(false);}
  }
  const managed=status?.mode==='managed',label=managed?'专用浏览器':'Chrome';
  return <section className="panel external-browser-settings" aria-label="网页登录浏览器设置">
    <div className="external-browser-heading"><div><h2>网页登录浏览器</h2><p>{managed?'软件自动启动专用 Chrome 或 Edge，登录资料持续保留。无需填写 IP、端口或每次批准接入。':'默认使用本机 Chrome。请在本工具打开的 Chrome 标签中登录，采集在同一 Chrome 会话中继续。'}</p></div><button className="button" disabled={checking||switching} onClick={refresh}>{checking?<LoaderCircle className="spin" size={15}/>:<RotateCw size={15}/>}检查{managed?'浏览器':' Chrome 接入'}</button></div>
    <div className="external-browser-status" role="status"><span className={`badge ${status?.available||status?.canStart?'blue':''}`}>{checking?`正在检查${label}…`:status?.available?`${label}${managed?'':' '}已接入`:managed&&status?.canStart?'使用时自动启动':`${label}${managed?'尚未准备':' 尚未接入'}`}</span><span>{error||status?.message||'点击账号的官方登录按钮，在打开的官方页面完成登录。'}</span></div>
    <p className="hint">{label}已接入只表示浏览器连接可用，不代表平台已登录。浏览器登录不会拷贝到内置窗口；搜索和评论采集沿用同一{label}会话。</p>
    {status?.canSwitch&&!managed&&<div className="external-browser-mode"><p className="hint">专用浏览器仅首次需要登录，之后自动复用。原 Chrome 登录和本地资料保留；切换会关闭本工具打开的原浏览器标签。</p><button className="button primary" disabled={checking||switching} onClick={()=>changeMode('managed')}>{switching?'正在切换…':'使用专用浏览器（推荐）'}</button></div>}
    {status?.canSwitch&&managed&&<details className="account-browser-advanced"><summary>原浏览器兼容</summary><p>需要使用原 Chrome 登录身份时可切回，Chrome 自身仍可能要求批准接入；专用浏览器登录资料保留。</p><button className="text-button" disabled={checking||switching} onClick={()=>changeMode('legacy')}>沿用原 Chrome 会话（兼容）</button></details>}
    <p className="hint">视频号网页登录用于原有分享链接解析；视频号搜索和评论采集仍连接电脑微信，两者分别验证。</p>
  </section>;
}

export function useAccountBrowserLogin(perform,notify){
  const [busy,setBusy]=useState(null),[errors,setErrors]=useState({}),[opened,setOpened]=useState(new Set());
  const pending=useRef(false),mounted=useRef(false),awaiting=useRef(new Map()),onReturn=useRef(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{const check=()=>onReturn.current?.();window.addEventListener('focus',check);return()=>window.removeEventListener('focus',check);},[]);
  useEffect(()=>{const reset=()=>{awaiting.current.clear();if(mounted.current)setOpened(new Set());};window.addEventListener('fengsha-browser-mode-changed',reset);return()=>window.removeEventListener('fengsha-browser-mode-changed',reset);},[]);
  async function act(account,kind,fn){
    if(pending.current)return null;
    pending.current=true;setBusy({id:account.id,kind});setErrors(old=>({...old,[account.id]:''}));
    try{return await fn();}
    catch(e){if(mounted.current)setErrors(old=>({...old,[account.id]:e.message}));return null;}
    finally{pending.current=false;if(mounted.current)setBusy(null);}
  }
  async function open(account,embedded=false){
    return act(account,embedded?'embedded':'open',async()=>{
      const result=await perform(embedded?'login':'openExternalLogin',account.id);
      if(!embedded&&result?.opened!==true)throw Error(result?.message||'Chrome 登录页尚未打开，请检查浏览器接入后重试。');
      if(mounted.current)setOpened(old=>new Set([...old,account.id]));
      if(!embedded)awaiting.current.set(account.id,account);else awaiting.current.delete(account.id);
      notify(result?.message||(embedded?'请在内置官方窗口完成登录，再回到本页检测。':'请在本工具打开的 Chrome 标签中完成官方登录，再回到本页点击“完成登录并检测”。'));
      return result;
    });
  }
  async function complete(account,automatic=false){
    return act(account,'complete',async()=>{
      const result=await perform('completeAccount',account.id,...(automatic?[{automatic:true}]:[]));
      if(automatic&&!result?.verified)return result;
      if(!result?.saved)throw Error(result?.message||'尚未保存有效会话，请在官方页面完成登录后重试。');
      if(result.verified!==false){awaiting.current.delete(account.id);if(mounted.current)setOpened(old=>{const next=new Set(old);next.delete(account.id);return next;});}
      const message=result.message||(result.verified?'已在官方页面确认登录，平台会话过期时需重新登录。':'会话已保留，平台登录状态尚待确认；采集时会继续验证。');
      notify(message);return result;
    });
  }
  onReturn.current=async()=>{if(pending.current)return;for(const account of awaiting.current.values()){if(!mounted.current)return;await complete(account,true);}};
  return {busy,errors,opened,open,complete};
}

export function AccountBrowserActions({account,login}){
  const ownBusy=login.busy?.id===account.id?login.busy.kind:null;
  const pending=!!login.busy;
  const completing=account.status==='登录中'||login.opened.has(account.id);
  const managed=account.browserMode==='managed',browser=managed?'专用浏览器':'Chrome';
  return <div className="account-browser-actions">
    <button className="button primary" disabled={pending} onClick={()=>completing?login.complete(account):login.open(account)}>{ownBusy?<LoaderCircle className="spin" size={16}/>:completing?<Check size={16}/>:<ExternalLink size={16}/>} {ownBusy==='complete'?'正在检测登录…':ownBusy==='open'?`正在打开${browser}…`:ownBusy==='embedded'?'正在打开内置窗口…':completing?'完成登录并检测':account.lastSync?(managed?'重新登录':'Chrome 重新登录'):(managed?'官方网页登录':'Chrome 官方登录')}</button>
    {completing&&<button className="text-button" disabled={pending} onClick={()=>login.open(account)}>重新显示 Chrome 登录页</button>}
    {account.loginBackend==='external-chrome'&&<span className="account-login-backend">使用 Chrome 会话</span>}
    {account.platform==='视频号'&&<span className="account-login-backend">视频号网页登录</span>}
    {login.errors[account.id]&&<p className="account-browser-error" role="alert">{login.errors[account.id]}</p>}
    <details className="account-browser-advanced"><summary>高级兼容</summary><button className="text-button" disabled={pending} onClick={()=>login.open(account,true)}>使用内置窗口登录（兼容）</button><p>已有内置会话仍可使用；Chrome 的登录不会自动同步到内置窗口。</p></details>
  </div>;
}
