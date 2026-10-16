// An error document also emits dom-ready. Only a committed official HTTPS
// document can release early navigation; load failures must still reject.
export async function navigateOfficialPage(window,url,{userAgent,early=false,signal,allowed,timeoutMs=30000}={}){
  let ready,timer,poll,finished=false;
  const dom=new Promise(resolve=>{
    ready=async()=>{
      if(finished||window.isDestroyed())return;
      try{
        const state=await window.webContents.executeJavaScript('({url:location.href,ready:document.readyState,content:!!document.body&&(document.body.children.length>0||!!document.body.innerText.trim())})');
        if(!finished&&state?.ready!=='loading'&&state?.content&&allowed(state.url))resolve();
      }catch{}
      if(!finished)poll=setTimeout(ready,100);
    };
  });
  const aborted=new Promise((_resolve,reject)=>{
    const abort=()=>reject(Error('CANCELLED'));
    ready.abort=abort;signal?.addEventListener('abort',abort,{once:true});
  });
  const timeout=new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('ERR_TIMED_OUT')),timeoutMs);});
  if(early)window.webContents.once('dom-ready',ready);
  try{
    signal?.throwIfAborted();
    await Promise.race([window.loadURL(url,{userAgent}),...(early?[dom]:[]),timeout,aborted]);
  }finally{
    finished=true;clearTimeout(timer);clearTimeout(poll);signal?.removeEventListener('abort',ready.abort);
    if(!window.isDestroyed())window.webContents.removeListener('dom-ready',ready);
  }
}
export const transientNavigationError=error=>/ERR_(?:FAILED|CONNECTION_(?:CLOSED|RESET|ABORTED|TIMED_OUT)|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED)/.test(String(error?.message||''));
