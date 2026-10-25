import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {domainToASCII} from 'node:url';
import YAML from 'yaml';

export const routeName='Fengsha-WeChat-Route', proxyName='Fengsha-WeChat-Local';
export const routeRule=`DOMAIN,channels.weixin.qq.com,${routeName}`;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const generalKeys=['port','mixed-port','socks-port','redir-port','tproxy-port','mode','allow-lan','bind-address','ipv6','log-level','tun'];
// Only the current local Windows Verge sidecar namespace is supported. Never
// accept UNC server pipes, alternate device namespaces or arbitrary pipe names.
const localVergePipe=value=>process.platform==='win32'&&typeof value==='string'&&(value===String.raw`\\.\pipe\verge-mihomo`||/^\\\\\.\\pipe\\verge-mihomo-(?:sidecar-release-[A-Za-z0-9_-]+|production-[a-f0-9]{64})$/i.test(value));
export function currentVergePipe(configured,names) {
  if(!localVergePipe(configured))return configured;
  const identity=/^verge-mihomo-(?:sidecar-release|production)-([a-f0-9]{64})$/i.exec(configured.split('\\').at(-1))?.[1];
  if(!identity)return configured;
  const available=new Set((names||[]).map(name=>String(name).split('\\').at(-1)));
  if(available.has(configured.split('\\').at(-1)))return configured;
  const production=`verge-mihomo-production-${identity}`;
  return available.has(production)?String.raw`\\.\pipe`+'\\'+production:configured;
}
function controllerRequest(url,options){
  if(!options.socketPath)return fetch(url,options);
  return new Promise((resolve,reject)=>{
    const endpoint=new URL(url);
    const headers={...options.headers};
    if(options.body!==undefined)headers['Content-Length']=Buffer.byteLength(options.body);
    const request=http.request({socketPath:options.socketPath,path:endpoint.pathname+endpoint.search,method:options.method,headers,signal:options.signal,agent:false},response=>{
      const status=response.statusCode,ok=status>=200&&status<300;
      if(options.redirect==='error'&&[301,302,303,307,308].includes(status)&&response.headers.location){response.destroy();reject(new Error('Controller redirect refused'));return;}
      // Error bodies are deliberately discarded, like api()'s fetch branch.
      if(!ok||status===204){response.destroy();resolve({ok,status});return;}
      if(status===205){response.destroy();resolve(new Response(null,{status}));return;}
      resolve(new Response(Readable.toWeb(response),{status}));
    });
    request.on('error',reject);
    request.end(options.body);
  });
}
export function parseClashConfig(source){
  const doc=YAML.parseDocument(source,{maxAliasCount:100});
  if(doc.errors.length)throw new Error('Clash 配置无法解析，未改变原网络；请在 Clash 中检查当前配置');
  // Hex IDs can look like decimal/exponent numbers to a generic YAML parser.
  // These fields are textual credentials; preserve the original lexical value.
  const textKeys=new Set(['short-id','uuid','password','secret','public-key','private-key']);
  YAML.visit(doc,{Pair(_key,pair){if(!textKeys.has(String(pair.key?.value)))return;const scalar=YAML.isAlias(pair.value)?pair.value.resolve(doc):pair.value;if(YAML.isScalar(scalar)&&scalar.value!=null&&typeof scalar.value!=='string'&&typeof scalar.source==='string'){const text=new YAML.Scalar(scalar.source);if(pair.value.anchor)text.anchor=pair.value.anchor;pair.value=text;}}});
  return doc.toJS({maxAliasCount:100});
}
export function rulesEquivalent(configured,actual){
  const type=value=>String(value).replace(/[-_]/g,'').toUpperCase().replace(/^IPCIDR6$/,'IPCIDR');
  // Mihomo returns canonical IDNA domains and lowercase country codes. Compare
  // those representations without relaxing rule order, targets or disabled rules.
  const canonical=(kind,value)=>{
    const raw=String(value||'');
    if(kind==='GEOIP')return raw.toUpperCase();
    if(['DOMAIN','DOMAINSUFFIX'].includes(kind))return domainToASCII(raw)||raw;
    return raw;
  };
  const normalizeAPI=payload=>String(payload).replace(/\(([A-Za-z][\w-]*),([^()]*)\)/g,(_s,name,value)=>`(${type(name)},${canonical(type(name),value)})`).replace(/\(([A-Za-z][\w-]*),/g,(_s,name)=>`(${type(name)},`).replace(/(NETWORK,)(tcp|udp)([),])/gi,(_s,p,n,e)=>p.toUpperCase()+n.toUpperCase()+e).replace(/\s*(&&|\|\|)\s*/g,'$1');
  const split=value=>{let depth=0,start=0,items=[];for(let i=0;i<value.length;i++){if(value[i]==='(')depth++;if(value[i]===')')depth--;if(depth<0)return null;if(value[i]===','&&depth===0){items.push(value.slice(start,i));start=i+1;}}if(depth!==0)return null;items.push(value.slice(start));return items;};
  const logical=(name,payload)=>{if(!['AND','OR'].includes(name)||!payload.startsWith('(')||!payload.endsWith(')'))return null;const children=split(payload.slice(1,-1));if(!children)return null;const values=children.map(child=>{if(!child.startsWith('(')||!child.endsWith(')'))return null;const fields=split(child.slice(1,-1));if(!fields||fields.length<2)return null;const kind=type(fields[0]),value=fields.slice(1).join(',');if(['AND','OR'].includes(kind))return logical(kind,value);return `(${kind},${kind==='NETWORK'?value.toUpperCase():canonical(kind,value)})`;});return values.some(v=>v===null)?null:`(${values.join(name==='AND'?'&&':'||')})`;};
  return Array.isArray(configured)&&Array.isArray(actual)&&configured.length===actual.length&&configured.every((line,i)=>{
    if(typeof line!=='string')return false;const parts=line.split(',').map(s=>s.trim());let target=parts.length-1;
    if(['no-resolve','resolve'].includes(parts[target]))target--;
    const payload=parts.slice(1,target).join(',');const rule=actual[i];if(!rule)return false;
    const kind=type(parts[0]);let equal=canonical(kind,payload)===canonical(kind,rule.payload);
    if(['AND','OR'].includes(kind)){const normalized=logical(kind,payload);equal=normalized!==null&&normalized===normalizeAPI(rule.payload);}
    return kind===type(rule.type)&&equal&&parts[target]===rule.proxy&&!rule.extra?.disabled;
  });
}
export function routedConfig(config,general) {
  if(general.mode!=='rule')throw new Error('视频号代理共存需要 Clash 处于规则模式；当前代理模式保持不变');
  if(!Array.isArray(config.rules)||!Array.isArray(config.proxies)||!Array.isArray(config['proxy-groups']))throw new Error('未找到完整的 Clash 配置，原代理保持不变');
  if([...config.proxies,...config['proxy-groups']].some(p=>[routeName,proxyName].includes(p.name)))throw new Error('已有同名视频号分流，请先恢复连接后再试');
  const c=structuredClone(config);
  for(const k of generalKeys)if(k in general)c[k]=general[k];
  c.proxies.push({name:proxyName,type:'http',server:'127.0.0.1',port:2023});
  c['proxy-groups'].push({name:routeName,type:'fallback',proxies:[proxyName,'DIRECT'],url:'http://www.qq.com',interval:5,lazy:false});
  c.rules.unshift(routeRule);
  return c;
}
export class ClashRoute {
  constructor(directory=path.join(process.env.APPDATA||'','io.github.clash-verge-rev.clash-verge-rev'),request=controllerRequest){this.directory=directory;this.fetch=request;}
  load(){
    const file=path.join(this.directory,'clash-verge.yaml');
    if(!fs.existsSync(file))return null;
    let c;try{c=parseClashConfig(fs.readFileSync(file,'utf8'));}catch{throw new Error('Clash 配置无法解析，未改变原网络；请在 Clash 中检查当前配置');}
    if(!c||typeof c!=='object'||Array.isArray(c))throw new Error('Clash 配置格式无效，未改变原网络');
    const address=String(c['external-controller']||'').replace(/^0\.0\.0\.0:/,'127.0.0.1:');
    if(!address&&localVergePipe(c['external-controller-pipe'])){
      let pipes=[];try{pipes=fs.readdirSync(String.raw`\\.\pipe`+'\\');}catch{}
      return {config:c,configurationDigest:digest(c),base:'http://localhost',socketPath:currentVergePipe(c['external-controller-pipe'],pipes),secret:String(c.secret||'')};
    }
    if(!/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(address))throw new Error('Clash 本机控制接口不可用，原网络保持不变');
    return {config:c,configurationDigest:digest(c),base:`http://${address}`,secret:String(c.secret||'')};
  }
  async api(context,route,body,method='GET'){
    if(context.socketPath!==undefined&&!localVergePipe(context.socketPath))throw new Error('Clash 本机控制接口不可用，原网络保持不变');
    let r;try{r=await this.fetch(context.base+route,{method,headers:{Authorization:`Bearer ${context.secret}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000),...(context.socketPath?{socketPath:context.socketPath}:{})});}catch{throw new Error('Clash 本机控制接口未响应，原代理设置保留');}
    if(!r.ok)throw new Error(`Clash 分流请求失败（HTTP ${r.status}），恢复记录保留在本机`);
    if(r.status===204)return null;try{return await r.json();}catch{throw new Error('Clash 本机接口返回无效数据，恢复记录保留在本机');}
  }
  async discover(proxy){
    if(!Number(proxy.ProxyEnable?.value)||!/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(String(proxy.ProxyServer?.value||'')))return null;
    const context=this.load();if(!context)return null;
    const port=Number(String(proxy.ProxyServer.value).split(':')[1]);
    if(![context.config['mixed-port'],context.config.port].includes(port))return null;
    const general=await this.api(context,'/configs');
    const address=String(proxy.ProxyServer?.value||'');
    if(!Number(proxy.ProxyEnable?.value)||!new RegExp(`^(127\\.0\\.0\\.1|localhost):(${general['mixed-port']}|${general.port})$`).test(address))return null;
    routedConfig(context.config,general);
    const actual=await this.api(context,'/rules');
    if(!rulesEquivalent(context.config.rules,actual.rules))throw new Error('Clash 正在使用不同的临时规则，未覆盖当前配置；请在 Clash 中重新载入当前配置后再试');
    return {directory:this.directory,configurationDigest:context.configurationDigest,rulesDigest:digest(actual.rules.map(r=>[r.type,r.payload,r.proxy])),ruleCount:actual.rules.length};
  }
  async selectors(context){const {proxies}=await this.api(context,'/proxies');return Object.fromEntries(Object.entries(proxies).filter(([,p])=>p.type==='Selector').map(([name,p])=>[name,p.now]));}
  async reload(context,config){
    const selected=await this.selectors(context);
    await this.api(context,'/configs?force=true',{payload:YAML.stringify(config)},'PUT');
    const failures=[];
    for(const [name,target] of Object.entries(selected))try{await this.api(context,`/proxies/${encodeURIComponent(name)}`,{name:target},'PUT');}catch{failures.push(name);}
    if(failures.length)throw new Error('Clash 已载入分流，但部分原节点选择未恢复，请检查 Clash 节点选择');
  }
  async begin(plan,signal){
    const context=this.load();if(!context)throw new Error('Clash 配置已移动，未切换网络');
    const rules=await this.api(context,'/rules');
    if(context.configurationDigest!==plan.configurationDigest||digest(rules.rules.map(r=>[r.type,r.payload,r.proxy]))!==plan.rulesDigest)throw new Error('准备期间 Clash 规则已变化，请重试；当前规则保持不变');
    const general=await this.api(context,'/configs');
    await this.reload(context,routedConfig(context.config,general));
    // Refresh fallback health without pinning it: a stopped collector must fall back.
    await this.api(context,`/group/${routeName}/delay?url=http%3A%2F%2Fwww.qq.com&timeout=5000`).catch(()=>{});
    const actual=await this.api(context,'/rules');
    if(actual.rules?.[0]?.payload!=='channels.weixin.qq.com'||actual.rules[0].proxy!==routeName)throw new Error('视频号专用分流未生效，已停止采集');
    // Existing HTTPS sockets retain the route chosen when they were opened.
    // Reconnect only this platform's stale TCP sockets; never flush all traffic.
    const current=await this.api(context,'/connections');
    if(signal?.aborted)throw new Error('CANCELLED');
    for(const connection of current.connections||[]){
      if(signal?.aborted)throw new Error('CANCELLED');
      if(connection.metadata?.host!=='channels.weixin.qq.com'||connection.metadata?.network!=='tcp'||!Array.isArray(connection.chains)||connection.chains.includes(proxyName)||typeof connection.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(connection.id))continue;
      await this.api(context,'/connections/'+connection.id,undefined,'DELETE');
      if(signal?.aborted)throw new Error('CANCELLED');
    }
  }
  async restore(plan){
    const context=this.load();if(!context)throw new Error('Clash 恢复配置不可用');
    const {rules}=await this.api(context,'/rules');
    if(!rules.some(r=>r.proxy===routeName))return;
    const owned=rules.filter(r=>r.proxy===routeName),others=rules.filter(r=>r.proxy!==routeName);
    if(context.configurationDigest!==plan.configurationDigest||owned.length!==1||owned[0].payload!=='channels.weixin.qq.com'||digest(others.map(r=>[r.type,r.payload,r.proxy]))!==plan.rulesDigest)throw new Error('Clash 规则已被其他操作修改，保留当前规则；视频号分流可在 Clash 重载配置后清除');
    const general=await this.api(context,'/configs');
    const c=context.config;for(const k of generalKeys)if(k in general)c[k]=general[k];
    await this.reload(context,c);
  }
}
