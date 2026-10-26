import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
export function articleURL(value,{list=false,result=false}={}){
  const u=new URL(String(value).trim().replace(/&amp;/g,'&'));
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port)throw Error('只接受公众号或小红书的官方文章链接');
  u.protocol='https:';u.hash='';let platform,identity;
  if(u.hostname==='mp.weixin.qq.com'&&(/^\/s(?:\/[-\w]+)?\/?$/.test(u.pathname)||list&&['/mp/appmsgalbum','/mp/profile_ext'].includes(u.pathname))){
    platform='公众号';
    const biz=u.searchParams.get('__biz'),mid=u.searchParams.get('mid'),idx=u.searchParams.get('idx');
    identity=biz&&mid?`${biz}:${mid}:${idx||'1'}`:u.pathname!=='/s'?u.pathname:u.href;
  }else if(['www.xiaohongshu.com','xiaohongshu.com'].includes(u.hostname)&&(/^\/(?:explore|discovery\/item)\/[a-f\d]{24}\/?$/i.test(u.pathname)||list&&/^\/user\/profile\/[a-f\d]{24}\/?$/i.test(u.pathname))){
    platform='小红书';identity=u.pathname.match(/[a-f\d]{24}/i)[0].toLowerCase();u.hostname='www.xiaohongshu.com';
  }else if(['xhslink.com','www.xhslink.com'].includes(u.hostname)&&u.pathname.length>1){platform='小红书';identity=u.href;}
  else if(result&&u.hostname==='weixin.sogou.com'&&u.pathname==='/link'){platform='公众号';identity=u.href;}
  else throw Error('链接不属于支持的公众号文章、小红书笔记或作者主页');
  return {id:hash(platform+':'+identity),platform,url:u.href,title:'待获取正文'};
}
export function articleLinks(text){
  if(typeof text!=='string'||text.length>100000)throw Error('请粘贴文章链接，每次最多 100 条');
  const urls=text.match(/https?:\/\/[^\s<>"“”]+/g)||[];
  if(!urls.length||urls.length>100)throw Error('请粘贴 1–100 条文章链接');
  const map=new Map();for(const raw of urls){const item=articleURL(raw.replace(/[，。；、！）)\]}]+$/g,''));map.set(item.id,item);}return [...map.values()];
}
export function articleIdentity(article){
  const source=articleURL(article.url),s=article.sourceIdentity;
  if(source.platform==='公众号'&&s&&/^[A-Za-z\d+/=]{1,200}$/.test(s.biz)&&/^\d{1,30}$/.test(s.mid)&&/^\d{1,4}$/.test(s.idx))source.id=articleURL(`https://mp.weixin.qq.com/s?${new URLSearchParams({__biz:s.biz,mid:s.mid,idx:s.idx})}`).id;
  return source;
}
export function wechatAuthor(article,input){
  const name=String(article.author||'').trim(),biz=article.sourceIdentity?.biz;
  if(!name)throw Error('原文未公开公众号名称，请检查文章链接');
  if(typeof biz!=='string'||! /^[A-Za-z\d+/=]{1,200}$/.test(biz))throw Error('原文未提供有效公众号账号标识，无法安全获取该账号的文章');
  let avatar='';try{avatar=imageURL(article.account?.avatar);}catch{}
  return {sourceInput:input,name,biz,avatar,username:String(article.account?.username||'').slice(0,100),description:String(article.account?.description||'').slice(0,300)};
}
export function wechatAccountPage(data,author,offset,count){
  const code=data?.base_resp?.ret;
  if([200003,200004].includes(code))throw Object.assign(Error('微信公众平台登录已失效，请连接后再点“更新获取”。'),{needsAction:true,wechatLogin:true});
  if(code===200013)throw Object.assign(Error('微信拒绝了外部公众号文章列表请求（200013 / freq control），冷却后仍可能受账号或平台限制；未取得的清单没有标记为成功。'),{rateLimited:true});
  if(code!==0)throw Error(`微信未返回有效的账号文章列表${Number.isInteger(code)?`（${code}）`:''}，未标记为获取成功。`);
  let raw=data.app_msg_list,total=data.app_msg_cnt,units=raw?.length,totalUnit='article';
  if(data.publish_page!==undefined){
    let page;try{page=typeof data.publish_page==='string'?JSON.parse(data.publish_page):data.publish_page;}catch{throw Error('微信发布列表数据损坏，未推进读取位置');}
    if(!page||!Array.isArray(page.publish_list))throw Error('微信发布列表格式无效，未推进读取位置');
    raw=[];units=page.publish_list.length;total=page.total_count;totalUnit='publish';
    for(const entry of page.publish_list){let info;try{info=typeof entry.publish_info==='string'?JSON.parse(entry.publish_info):entry.publish_info;}catch{throw Error('微信单条发布记录损坏，未跳过或推进读取位置');}if(!Array.isArray(info?.appmsgex))throw Error('微信发布记录缺少文章明细，未推进读取位置');raw.push(...info.appmsgex);}
  }
  if(!Array.isArray(raw))throw Error('微信未返回有效的账号文章明细，未标记为获取成功。');
  total=Number.isInteger(total)&&total>=0?total:null;const items=new Map();
  if(!units&&total!==null&&offset<total)throw Error('微信返回空列表，但尚有未读取文章，请稍后重试。');
  for(const value of raw)try{
    const item=articleURL(value.link),u=new URL(item.url);if(item.platform!=='公众号'||u.searchParams.has('__biz')&&u.searchParams.get('__biz')!==author.biz)continue;
    let thumbnail='';try{thumbnail=imageURL(value.cover);}catch{}
    const time=Number(value.create_time||value.update_time);
    items.set(item.id,{...item,title:String(value.title||'待获取标题'),author:author.name,thumbnail,publishedAt:Number.isFinite(time)&&time>0?new Date(time*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):null});
  }catch{}
  if(raw.length&&!items.size)throw Error('微信返回的文章链接未通过账号身份或链接校验，未标记为获取成功。');
  const next=offset+units;
  return {items:[...items.values()],offset:next,total,totalUnit,units,complete:total!==null?next>=total:units<count};
}
export async function wechatAccountRetry(request,{signal,progress=()=>{},wait=(ms,signal)=>delay(ms,undefined,{signal})}={}){
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();const data=await request();signal?.throwIfAborted();
    if(data?.base_resp?.ret!==200013||attempt===2)return data;
    const seconds=(attempt+1)*20;progress(`微信返回 200013，正在冷却 ${seconds} 秒后重试当前页（${attempt+1}/2）；请勿重复点击。`);
    await wait(seconds*1000,signal);signal?.throwIfAborted();
  }
}
export function articleRequest(raw={}){
  const {mode='links',platform='公众号'}=raw,input=String(raw.input||'').trim(),limit=Number(raw.limit??30);
  if(!['links','author','search'].includes(mode)||!['公众号','小红书'].includes(platform)||!Number.isInteger(limit)||limit<1||limit>100||!input||input.length>100000)throw Error('请检查采集方式、平台、输入及数量（1–100）');
  if(mode==='links')articleLinks(input);
  else if(mode==='author'&&(platform==='小红书'||/^https?:/.test(input))){const item=articleURL(input,{list:true});if(item.platform!==platform)throw Error('主页链接与所选平台不一致');}
  else if(input.length>100)throw Error('关键词或公众号名称最多 100 个字符');
  return {mode,platform,input,limit};
}
export function imageURL(value){
  const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.port||u.username||u.password||!(u.hostname==='res.wx.qq.com'||/(^|\.)(qpic\.cn|qlogo\.cn|xhscdn\.com|xiaohongshu\.com)$/.test(u.hostname)))throw Error('图片地址不属于平台图片域名');
  u.protocol='https:';return u.href;
}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const md=value=>esc(value).replace(/([\\`*_{}\[\]])/g,'\\$1');
export function articleFiles(article,assets){
  const byURL=new Map(assets.map(a=>[a.url,a.file]));
  const blocks=article.blocks||[],heading=`# ${md(article.title)}\n\n作者：${md(article.author||'未公开')}\n\n发布时间：${md(article.publishedAt||'未公开')}\n\n原文：${article.url}\n\n`;
  const text=blocks.map(b=>b.type==='image'?`[图片] ${b.url}`:b.text).join('\n\n');
  const markdown=heading+blocks.map(b=>b.type==='image'?(byURL.has(b.url)?`![](./${byURL.get(b.url)})`:`[图片未下载：${md(b.url)}]`):md(b.text)).join('\n\n');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(article.title)}</title><style>body{font:18px/1.9 system-ui;max-width:850px;margin:40px auto;padding:20px;color:#182235}img{max-width:100%;height:auto}p{white-space:pre-wrap;overflow-wrap:anywhere}header{color:#637083}</style><h1>${esc(article.title)}</h1><header>${esc(article.author||'未公开作者')} · ${esc(article.publishedAt||'未公开日期')}<p>原文：${esc(article.url)}</p></header>${blocks.map(b=>b.type==='image'?(byURL.has(b.url)?`<img alt="文章图片" src="${esc(byURL.get(b.url))}">`:'<p>[图片未下载]</p>'):`<p>${esc(b.text)}</p>`).join('')}</html>`;
  return {markdown,html,text:`${article.title}\n${article.author||''}\n${article.url}\n\n${text}`};
}
