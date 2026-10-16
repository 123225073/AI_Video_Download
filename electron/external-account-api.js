const biliQueries={
  '/x/web-interface/nav':[],
  '/x/web-interface/view':['aid','bvid'],
  '/x/web-interface/search/type':['search_type','order','keyword','page','page_size'],
  '/x/space/wbi/arc/search':['mid','pn','ps','keyword','order','order_avoided','platform','tid','web_location','special_type','index','wts','w_rid']
};
const sourceURL=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&((u.hostname==='weixin.qq.com'&&/^\/sph\/[a-zA-Z0-9_-]{1,100}\/?$/.test(u.pathname))||(u.hostname==='channels.weixin.qq.com'&&u.pathname==='/finder-preview/pages/sph'));}catch{return false;}};

export function externalApiSpec(platform,value,options={}){
  let u;try{u=new URL(value);}catch{throw Error('浏览器接口地址无效');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||u.href.length>8192)throw Error('浏览器接口地址无效');
  const entries=Object.entries(options.headers||{});
  if(entries.some(([name])=>/cookie|authorization|token|password/i.test(name)))throw Error('浏览器接口不接受凭据请求头');
  const method=String(options.method||'GET').toUpperCase(),headers={Accept:'application/json'};
  if(platform==='B站'&&u.origin==='https://api.bilibili.com'&&Object.hasOwn(biliQueries,u.pathname)){
    if(method!=='GET'||options.body!=null||[...u.searchParams.keys()].some(key=>!biliQueries[u.pathname].includes(key)))throw Error('B站浏览器接口仅允许现有只读查询');
    const language=entries.find(([name])=>name.toLowerCase()==='accept-language')?.[1];if(typeof language==='string'&&language.length<=160)headers['Accept-Language']=language;
    return {url:u.href,pageURL:'https://www.bilibili.com/',method,headers,credentials:'include',maxBytes:2*1024*1024,timeoutMs:15000};
  }
  if(platform==='视频号'&&((u.origin==='https://yuanbao.tencent.com'&&u.pathname==='/api/weixin/get_parse_result')||(u.origin==='https://channels.weixin.qq.com'&&u.pathname==='/finder-preview/api/feed/get_feed_info'))){
    if(method!=='POST'||u.search||typeof options.body!=='string'||options.body.length>65536)throw Error('视频号浏览器接口参数无效');
    let body;try{body=JSON.parse(options.body);}catch{throw Error('视频号浏览器接口参数无效');}
    const yuanbao=u.origin==='https://yuanbao.tencent.com';
    if(yuanbao){if(!body||body.type!=='video_channel_url'||body.scene!==1||!sourceURL(body.url)||Object.keys(body).some(k=>!['type','scene','url'].includes(k)))throw Error('元宝接口仅允许解析所选视频号分享链接');}
    else if(!body||typeof body.exportId!=='string'||!body.exportId||body.exportId.length>8192||typeof body.baseReq?.generalToken!=='string'||!body.baseReq.generalToken||body.baseReq.generalToken.length>8192||Object.keys(body).some(k=>!['baseReq','exportId'].includes(k))||Object.keys(body.baseReq).some(k=>k!=='generalToken'))throw Error('视频号预览接口仅允许读取所选作品');
    return {url:u.href,pageURL:u.origin+'/',method,headers:{...headers,'Content-Type':'application/json'},body:options.body,credentials:yuanbao?'include':'omit',maxBytes:2*1024*1024,timeoutMs:30000};
  }
  throw Error('不允许通过浏览器调用此平台接口');
}

// Runs only in a tab owned by this tool. Authentication stays in Chrome.
export async function externalPageFetch(spec){
  if(location.origin!==new URL(spec.pageURL).origin)throw Error('官方页面已跳转，不能在当前页面读取接口');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),spec.timeoutMs);
  try{
    const response=await fetch(spec.url,{method:spec.method,headers:spec.headers,...(spec.body==null?{}:{body:spec.body}),credentials:spec.credentials,redirect:'error',signal:controller.signal});
    if(Number(response.headers.get('content-length'))>spec.maxBytes)throw Error('平台接口响应过大，已停止读取');
    const reader=response.body?.getReader(),chunks=[];let size=0;
    if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>spec.maxBytes){await reader.cancel();throw Error('平台接口响应过大，已停止读取');}chunks.push(next.value);}}finally{reader.releaseLock();}}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return {status:response.status,ok:response.ok,text:new TextDecoder().decode(bytes)};
  }finally{clearTimeout(timer);}
}

export function abortableApi(promise,signal,onAbort){
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const abort=()=>{onAbort?.();reject(signal.reason||Error('CANCELLED'));};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
}
