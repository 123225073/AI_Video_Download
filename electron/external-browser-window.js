import {EventEmitter} from 'node:events';

// Adapt only app-owned Chrome tabs to the existing browser workflow boundary.
// hide() never hides/minimizes the user's browser or any unrelated tab.
export async function externalBrowserWindow(manager,url,platform,{session}={}){
  const tab=await manager.open(url,{platform,deferNavigation:true});
  try{await tab.show();}catch(error){await tab.close().catch(()=>{});throw error;}
  const window=new EventEmitter(),contents=new EventEmitter(),debuggerApi=new EventEmitter();
  let destroyed=false,attached=false;
  Object.assign(debuggerApi,{isAttached:()=>attached,attach:()=>{attached=true;},detach:()=>{attached=false;},sendCommand:(method,params)=>tab.send(method,params)});
  Object.assign(contents,{debugger:debuggerApi,session,getURL:()=>tab.url,getUserAgent:()=>window.userAgent||'',setAudioMuted:()=>{},setWindowOpenHandler:()=>{},executeJavaScript:expression=>tab.evaluate(expression),isDestroyed:()=>destroyed,loadURL:(...args)=>window.loadURL(...args)});
  Object.assign(window,{webContents:contents,externalTab:tab,setMenu:()=>{},hide:()=>{},show:()=>{void tab.show().catch(()=>{});},focus:()=>{},isDestroyed:()=>destroyed||tab.closed,
    async loadURL(value){await tab.navigate(value,{waitUntil:'load'});try{window.userAgent=await tab.evaluate('navigator.userAgent');}catch{}return window;},
    destroy(){if(destroyed)return;destroyed=true;void tab.close().catch(()=>{});},close(){window.destroy();}});
  tab.on('event',(method,params)=>{
    if(destroyed)return;
    if(method.startsWith('Network.'))debuggerApi.emit('message',null,method,params);
    if(method==='Page.domContentEventFired')contents.emit('dom-ready');
    if(method==='Page.loadEventFired')contents.emit('did-finish-load');
  });
  tab.on('closed',()=>{destroyed=true;window.emit('closed');});
  return window;
}
