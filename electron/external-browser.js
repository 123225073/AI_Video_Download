import http from 'node:http';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ENDPOINT='http://127.0.0.1:9222';
const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]']);
const messages={
  ready:'已连接本机 Chrome；平台登录是否有效，以官方页面实际结果为准。',
  'not-running':'未接入本机 Chrome，仍可打开官方网页；请在 Chrome 中开启并允许本机调试连接后再试。',
  timeout:'本机 Chrome 连接超时；请确认 Chrome 已打开并允许本机调试连接。',
  'http-error':'本机 Chrome 调试入口没有返回有效状态，尚不能同步读取官方网页。',
  'invalid-response':'本机 Chrome 调试入口返回空内容或非调试信息，尚未建立连接；打开网页不代表登录已同步。',
  'invalid-endpoint':'Chrome 调试连接必须使用本机回环地址。',
  'connection-failed':'本机 Chrome 调试连接未建立，请在 Chrome 中确认连接授权后再试。'
  ,'requires-approval':'已找到本机 Chrome；接入时请在 Chrome 弹出的官方确认框中点击允许，平台登录状态保留在 Chrome。'
};
const state=(reason,extra={})=>({available:reason==='ready',reason,message:messages[reason]||messages['connection-failed'],...extra});
function endpointURL(value){
  const u=new URL(value);
  if(u.protocol!=='http:'||!LOOPBACK.has(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('invalid-endpoint');
  return u;
}
function websocketURL(value,endpoint){
  const u=new URL(value);
  if(u.protocol!=='ws:'||!LOOPBACK.has(u.hostname)||u.username||u.password||u.port!==endpoint.port||!/^\/devtools\/browser\/[\w-]+$/.test(u.pathname)||u.search||u.hash)throw Error('invalid-response');
  return u.href;
}
function readEndpoint(url,timeoutMs){
  return new Promise((resolve,reject)=>{
    const request=http.get(url,{headers:{accept:'application/json'},timeout:timeoutMs},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>256*1024){request.destroy(Error('invalid-response'));return;}chunks.push(chunk);});
      response.on('end',()=>resolve({statusCode:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
      response.on('error',reject);
    });
    request.on('timeout',()=>request.destroy(Object.assign(Error('timeout'),{code:'ETIMEDOUT'})));
    request.on('error',reject);
  });
}

export function defaultChromeActivePortFile(){return process.platform==='win32'&&process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Google','Chrome','User Data','DevToolsActivePort'):null;}
export async function chromeActivePort({file=defaultChromeActivePortFile(),readFile=fs.readFile}={}){
  if(!file)return null;
  try{
    const content=await readFile(file,'utf8');if(content.length>2048)return null;
    const lines=content.trim().split(/\r?\n/).map(line=>line.trim());
    if(lines.length!==2||!/^\d{1,5}$/.test(lines[0])||Number(lines[0])<1||Number(lines[0])>65535)return null;
    const endpoint=new URL('http://127.0.0.1:'+Number(lines[0]));
    return websocketURL('ws://127.0.0.1:'+Number(lines[0])+lines[1],endpoint);
  }catch{return null;}
}
export async function externalChromeStatus({endpoint=DEFAULT_ENDPOINT,timeoutMs=2500,read=readEndpoint,discover=true,activePortFile,readActivePort=chromeActivePort}={}){
  let u;
  try{u=endpointURL(endpoint);}catch{return state('invalid-endpoint');}
  let failure;
  try{
    const response=await read(new URL('/json/version',u),timeoutMs);
    if(response.statusCode!==200)failure=state('http-error',{httpStatus:response.statusCode});
    else{
      let data;try{data=JSON.parse(response.body);}catch{}
      if(!data||typeof data!=='object'||typeof data.Browser!=='string'||!/(?:Chrome|Chromium)\//.test(data.Browser)||typeof data.webSocketDebuggerUrl!=='string')failure=state('invalid-response');
      else return state('ready',{socketURL:websocketURL(data.webSocketDebuggerUrl,u),browserVersion:data.Browser});
    }
  }catch(e){failure=state(e.message==='invalid-response'?'invalid-response':e.code==='ETIMEDOUT'||e.message==='timeout'?'timeout':['ECONNREFUSED','ENOTFOUND','ECONNRESET'].includes(e.code)?'not-running':'connection-failed');}
  if(discover){const socketURL=await readActivePort({file:activePortFile});if(socketURL)return state('requires-approval',{canConnect:true,requiresApproval:true,socketURL,connectionMode:'native-permission'});}
  return failure;
}

const officialDomains={
  '小红书':['xiaohongshu.com','xhslink.com'],
  '抖音':['douyin.com','iesdouyin.com'],
  'B站':['bilibili.com'],
  'YouTube':['youtube.com'],
  '视频号':['weixin.qq.com','yuanbao.tencent.com']
};
export function externalOfficialURL(platform,value){
  try{
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port)return false;
    if((officialDomains[platform]||[]).some(domain=>u.hostname===domain||u.hostname.endsWith('.'+domain)))return true;
    return platform==='YouTube'&&(['accounts.google.com','consent.google.com'].includes(u.hostname)||u.hostname==='www.google.com'&&/^\/sorry(?:\/|$)/.test(u.pathname));
  }catch{return false;}
}

function safeNetworkParams(params){
  const cleanHeaders=headers=>Object.fromEntries(Object.entries(headers||{}).filter(([name])=>!/cookie|authorization/i.test(name)));
  const next={...params};
  if(params.request)next.request={...params.request,headers:cleanHeaders(params.request.headers)};
  if(params.response)next.response={...params.response,headers:cleanHeaders(params.response.headers)};
  // ExtraInfo events may contain cookies and are deliberately never forwarded.
  return next;
}
function authenticationRequest(value){
  try{const u=new URL(value);return ['accounts.google.com','accounts.youtube.com','consent.google.com','consent.youtube.com'].includes(u.hostname)||/^(?:passport|xpassport|sso)\./.test(u.hostname)||u.hostname==='www.google.com'&&u.pathname.startsWith('/sorry/')||/\/(?:login|signin|auth|oauth|passport|captcha|verify|sms|qrcode)(?:[\/_-]|$)/i.test(u.pathname);}catch{return true;}
}

class CDPConnection extends EventEmitter{
  constructor(socket,{timeoutMs=15000}={}){
    super();this.socket=socket;this.timeoutMs=timeoutMs;this.nextId=0;this.pending=new Map();this.connected=false;
    socket.addEventListener('message',event=>{
      let message;try{message=JSON.parse(String(event.data));}catch{return;}
      if(message.id){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);if(message.error)pending.reject(Error(message.error.message||'Chrome command failed'));else pending.resolve(message.result||{});}
      else if(message.method)this.emit('event',message);
    });
    socket.addEventListener('close',()=>{this.connected=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Chrome connection closed'));}this.pending.clear();this.emit('closed');});
    socket.addEventListener('error',()=>{});
  }
  async ready(timeoutMs=5000){
    if(this.socket.readyState===1){this.connected=true;return;}
    await new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);this.socket.removeEventListener('open',open);this.socket.removeEventListener('error',failed);this.socket.removeEventListener('close',failed);error?reject(error):resolve();};
      const open=()=>{this.connected=true;done();},failed=()=>done(Error('Chrome connection failed'));
      const timer=setTimeout(()=>done(Error('Chrome connection timed out')),timeoutMs);
      this.socket.addEventListener('open',open,{once:true});this.socket.addEventListener('error',failed,{once:true});this.socket.addEventListener('close',failed,{once:true});
    });
  }
  send(method,params={},sessionId){
    if(!this.connected)return Promise.reject(Error('Chrome connection closed'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Chrome command timed out: '+method));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  close(){this.socket.close();}
}

export class ExternalBrowser extends EventEmitter{
  constructor({endpoint=DEFAULT_ENDPOINT,WebSocketImpl=globalThis.WebSocket,read=readEndpoint,timeoutMs=15000,connectTimeoutMs=45000,discover=true,activePortFile,readActivePort=chromeActivePort}={}){
    super();Object.assign(this,{endpoint,WebSocketImpl,read,timeoutMs,connectTimeoutMs,discover,activePortFile,readActivePort});this.tabs=new Map();this.connection=null;this.lastStatus=state('not-running');
  }
  async status(){
    if(this.connection?.connected)return this.publicStatus(state('ready'));
    this.lastStatus=await externalChromeStatus(this);return this.publicStatus(this.lastStatus);
  }
  publicStatus(value){const {socketURL,...safe}=value;return safe;}
  async connect(){
    if(this.connection?.connected)return this;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      const status=this.lastStatus=await externalChromeStatus(this);
      if(!status.available&&!status.canConnect)throw Object.assign(Error(status.message),{reason:status.reason});
      if(typeof this.WebSocketImpl!=='function')throw Object.assign(Error(messages['connection-failed']),{reason:'connection-failed'});
      const connection=new CDPConnection(new this.WebSocketImpl(status.socketURL),{timeoutMs:this.timeoutMs});
      try{await connection.ready(this.connectTimeoutMs);await connection.send('Browser.getVersion');}catch(e){connection.close();this.lastStatus=state(status.requiresApproval?'requires-approval':'connection-failed',{requiresApproval:!!status.requiresApproval});throw Object.assign(Error(this.lastStatus.message),{reason:this.lastStatus.reason,requiresApproval:!!status.requiresApproval});}
      this.connection=connection;connection.on('event',message=>{if(message.sessionId){for(const tab of this.tabs.values())if(tab.sessionId===message.sessionId)tab.receive(message.method,message.params||{});}else if(message.method==='Target.detachedFromTarget'){for(const tab of this.tabs.values())if(tab.sessionId===message.params?.sessionId)tab.detached();}});
      connection.once('closed',()=>{if(this.connection===connection)this.connection=null;this.lastStatus=state('not-running');for(const tab of this.tabs.values())tab.detached();this.emit('disconnected');});
      return this;
    })();
    try{return await this.connecting;}finally{this.connecting=null;}
  }
  async open(url,{platform,allowURL,onEvent,waitUntil='domcontentloaded',timeoutMs=30000,navigate=true,deferNavigation=false}={}){
    const allowed=value=>externalOfficialURL(platform,value)&&(!allowURL||allowURL(value));
    if(!allowed(url))throw Error('只允许在所选平台的官方网页中继续。');
    await this.connect();const connection=this.connection;
    const {targetId}=await connection.send('Target.createTarget',{url:'about:blank',background:true});
    if(!targetId)throw Error('Chrome 未返回本工具新建的网页标识。');
    const tab=new ExternalBrowserTab(this,targetId,allowed);this.tabs.set(targetId,tab);if(onEvent)tab.on('event',onEvent);
    try{
      const attached=await connection.send('Target.attachToTarget',{targetId,flatten:true});tab.sessionId=attached.sessionId;
      if(!tab.sessionId)throw Error('Chrome 未允许连接本工具新建的网页。');
      await connection.send('Page.enable',{},tab.sessionId);await connection.send('Runtime.enable',{},tab.sessionId);await connection.send('Network.enable',{maxResourceBufferSize:6*1024*1024,maxTotalBufferSize:12*1024*1024},tab.sessionId);
      if(navigate&&!deferNavigation)await tab.navigate(url,{waitUntil,timeoutMs});return tab;
    }catch(e){await tab.close().catch(()=>{});throw e;}
  }
  async close(){
    const results=await Promise.allSettled([...this.tabs.values()].map(tab=>tab.close()));
    this.connection?.close();this.connection=null;return results;
  }
}

export class ExternalBrowserTab extends EventEmitter{
  constructor(owner,targetId,allowed){super();Object.assign(this,{owner,targetId,allowed,sessionId:null,url:'about:blank',closed:false});this.privateRequests=new Set();}
  send(method,params={}){
    if(this.closed||this.owner.tabs.get(this.targetId)!==this||!this.owner.connection?.connected)return Promise.reject(Error('本工具的 Chrome 网页连接已关闭，请重新打开。'));
    const methods=new Set(['Page.enable','Page.getFrameTree','Page.navigate','Page.reload','Runtime.enable','Runtime.evaluate','Network.enable','Network.disable','Network.getResponseBody','DOM.getDocument','DOM.querySelectorAll','DOM.getAttributes','DOM.setFileInputFiles','Input.insertText','Input.dispatchKeyEvent','Input.dispatchMouseEvent']);
    if(!methods.has(method))return Promise.reject(Error('此 Chrome 操作不属于本工具网页的授权范围。'));
    if(method==='Page.navigate'&&!this.allowed(params.url))return Promise.reject(Error('只允许打开所选平台的官方网页。'));
    if(method==='Network.getResponseBody'&&this.privateRequests.has(params.requestId))return Promise.reject(Error('登录和验证数据只保留在 Chrome，不向工具读取。'));
    return this.owner.connection.send(method,params,this.sessionId);
  }
  receive(method,params){
    if(method==='Page.frameNavigated'&&!params.frame?.parentId){this.url=params.frame.url;this.frameId=params.frame.id;}
    if(method==='Page.navigatedWithinDocument'&&(!this.frameId||params.frameId===this.frameId))this.url=params.url;
    if(method==='Inspector.detached'){this.detached();return;}
    if(/ExtraInfo$/.test(method))return;
    if(method==='Network.requestWillBeSent'&&authenticationRequest(params.request?.url))this.privateRequests.add(params.requestId);
    if(method==='Network.responseReceived'&&authenticationRequest(params.response?.url))this.privateRequests.add(params.requestId);
    if(method.startsWith('Network.')&&this.privateRequests.has(params.requestId))return;
    if(method.startsWith('Network.')&&!['Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed','Network.requestServedFromCache'].includes(method))return;
    if(method==='Runtime.consoleAPICalled'||method==='Runtime.exceptionThrown')return;
    const data=method.startsWith('Network.')?safeNetworkParams(params):params;
    this.emit('event',method,data);this.emit(method,data);
  }
  detached(){if(this.closed)return;this.closed=true;this.owner.tabs.delete(this.targetId);this.emit('closed');}
  async currentURL(){
    const {frameTree}=await this.send('Page.getFrameTree');const url=frameTree?.frame?.url;
    if(typeof url==='string')this.url=url;return this.url;
  }
  async navigate(url,{waitUntil='domcontentloaded',timeoutMs=30000}={}){
    if(!this.allowed(url))throw Error('只允许打开所选平台的官方网页。');
    let resolveReady,closed,timer;
    const event=waitUntil==='load'?'Page.loadEventFired':'Page.domContentEventFired';
    const ready=new Promise(resolve=>{resolveReady=resolve;closed=()=>resolve({closed:true});this.once(event,resolveReady);this.once('closed',closed);timer=setTimeout(()=>resolve({timedOut:true}),timeoutMs);});
    try{
      this.url=url;const result=await this.send('Page.navigate',{url});
      if(result.errorText)throw Error('Chrome 官方页面加载失败：'+result.errorText);
      this.frameId=result.frameId||this.frameId;
      if(waitUntil!=='none'&&result.loaderId){const loaded=await ready;if(loaded?.closed)throw Error('本工具的 Chrome 网页已关闭，已有资料保留。');if(loaded?.timedOut)throw Error('Chrome 官方页面加载超时；可在 Chrome 中检查后继续。');}
      return this;
    }finally{clearTimeout(timer);this.removeListener(event,resolveReady);this.removeListener('closed',closed);}
  }
  async evaluate(expression,{awaitPromise=true,userGesture=false}={}){
    const current=await this.currentURL();
    if(!this.allowed(current))throw Error('Chrome 网页已离开所选平台，已有资料保留。');
    const result=await this.send('Runtime.evaluate',{expression:String(expression),returnByValue:true,awaitPromise,userGesture});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'Chrome 页面读取异常');
    return result.result?.value;
  }
  async show(){if(this.closed||this.owner.tabs.get(this.targetId)!==this||!this.owner.connection?.connected)throw Error('本工具的 Chrome 网页连接已关闭，请重新打开。');await this.owner.connection.send('Target.activateTarget',{targetId:this.targetId});}
  async responseBody(requestId){return this.send('Network.getResponseBody',{requestId});}
  async close(){
    if(this.closed)return {closed:true};
    if(this.owner.tabs.get(this.targetId)!==this)throw Error('不能关闭非本工具创建的 Chrome 网页。');
    if(!this.owner.connection?.connected)throw Error('Chrome 连接已中断，无法确认关闭本工具网页。');
    const result=await this.owner.connection.send('Target.closeTarget',{targetId:this.targetId});
    if(result.success===false)throw Error('Chrome 未关闭本工具网页。');
    this.detached();return {closed:true};
  }
}
