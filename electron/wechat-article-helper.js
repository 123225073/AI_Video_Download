import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {articleURL} from './article-data.js';

export const wechatClientAction=message=>Object.assign(Error(message||'请登录电脑微信，打开此公众号的文章或主页，然后点击“读取电脑微信列表”。无需重新登录公众号后台。'),{needsAction:true,wechatClient:true});
export function clientArticle(value,author){
 if(!value||value.author!==author.name||typeof value.title!=='string'||!value.title.trim()||value.title.length>500||typeof value.nativeKey!=='string'||!value.nativeKey||value.nativeKey.length>500)throw Error('微信客户端文章记录无效');
 const source=articleURL(value.url),url=new URL(source.url);
 if(source.platform!=='公众号'||url.searchParams.get('__biz')&&url.searchParams.get('__biz')!==author.biz)throw Error('微信客户端文章不属于目标公众号');
 for(const key of [...url.searchParams.keys()])if(!['__biz','mid','idx','sn','chksm'].includes(key))url.searchParams.delete(key);
 return {...source,url:url.href,title:value.title.trim(),author:author.name,nativeKey:value.nativeKey,publishedAt:typeof value.date==='string'?value.date.slice(0,40):null};
}
export class WeChatArticleHelper{
 constructor(bin,{launch=spawn,platform=process.platform,exists=fs.existsSync,wait=delay}={}){this.executable=path.join(bin,'collector','wechat-article-helper.exe');Object.assign(this,{launch,platform,exists,wait});}
 step(action,config,signal){
  signal?.throwIfAborted();
  if(!['inspect','open-card','read-article','return-article','author-profile','scroll'].includes(action))throw Error('Invalid desktop article step');
  return new Promise((resolve,reject)=>{
   const child=this.launch(this.executable,[action,Buffer.from(JSON.stringify(config)).toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   let raw='',bytes=0,settled=false;
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
   const cancel=()=>{child.kill();finish(signal.reason||Error('CANCELLED'));};
   const timer=setTimeout(()=>{child.kill();finish(wechatClientAction('电脑微信响应超时，已有文章保留。请保持公众号窗口展开后继续。'));},12000);
   signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>1024*1024){child.kill();finish(wechatClientAction('电脑微信返回数据过大，已停止读取。'));return;}raw+=chunk;});
   child.stderr?.resume();child.on('error',()=>finish(wechatClientAction('电脑微信采集组件未能启动，请安装完整版本。')));
   child.on('close',()=>{if(settled)return;try{
    const lines=raw.replace(/^\uFEFF/,'').trim().split(/\r?\n/);if(lines.length!==1)throw Error('Invalid response');
    const event=JSON.parse(lines[0]),value=event.value;
    if(event.kind!=='result'||value?.author!==config.name||value.username!==config.username)throw Error('Account identity mismatch');
    if(value.ok!==true)throw wechatClientAction();finish(null,value);
   }catch(e){finish(e.wechatClient?e:wechatClientAction('电脑微信响应未通过账号校验，已有清单保留。'));}});
  });
 }
 async collect(author,{limit=30,knownKeys=[],resumeUrl=null,signal,received=()=>{},progress=()=>{}}={}){
  signal?.throwIfAborted();
  if(this.platform!=='win32'||!this.exists(this.executable))throw wechatClientAction('此版本未提供电脑微信采集组件，请安装完整 Windows 版本。');
  if(!author?.name||!author?.biz||!author?.username||!Number.isInteger(limit)||limit<1||limit>100)throw wechatClientAction('请先粘贴此公众号的一篇文章链接识别账号，再打开电脑微信中的文章或主页。');
  const config={name:author.name,username:author.username,biz:author.biz,limit};
  const call=(action,params={},token=signal)=>this.step(action,{...config,...params},token);
  const profile=async(token=signal)=>{let page;for(let n=0;n<12;n++){page=await call('inspect',{},token);if(page.profileFound)return page;await this.wait(200,undefined,token?{signal:token}:undefined);}throw wechatClientAction();};
  const visited=new Set(knownKeys.filter(k=>typeof k==='string')),items=new Map();let pending=null,returned=false,complete=false;
  let page=await call('inspect');
  if(!page.profileFound){
   const existing=resumeUrl&&(page.articles||[]).find(a=>a.url===resumeUrl);
   if(existing)await call('return-article',{title:existing.title,url:existing.url});else await call('author-profile');
   page=await profile();
  }
  returned=true;let stagnant=0;
  try{
   for(let scan=0;scan<600&&items.size<limit;scan++){
    signal?.throwIfAborted();const card=(page.cards||[]).find(c=>!visited.has(c.key));
    if(!card){
     if(page.complete){complete=true;break;}
     const before=(page.cards||[]).map(c=>c.key).join('\n');await call('scroll');await this.wait(700,undefined,signal?{signal}:undefined);page=await profile();
     const after=(page.cards||[]).map(c=>c.key).join('\n');stagnant=before===after?stagnant+1:0;if(stagnant>=3)break;continue;
    }
    stagnant=0;progress('正在读取电脑微信文章：'+card.title);returned=false;
    // Fresh processes avoid retaining stale WeChat UIA providers across pages.
    // Invoke input once; repeat only passive observations afterwards.
    await call('open-card',{cardKey:card.key});let result;
    for(let n=0;n<16;n++){result=await call('read-article',{title:card.title,cardKey:card.key,date:card.key.split('|')[0]});if(result.ready)break;await this.wait(200,undefined,signal?{signal}:undefined);}
    if(!result?.ready)throw wechatClientAction('微信文章尚未加载完成，已有清单保留。请待文章显示后继续。');
    const item=clientArticle(result.item,author);items.set(item.id,item);pending=item;received([...items.values()],item.url);
    await call('return-article',{title:item.title,url:item.url});page=await profile();returned=true;visited.add(card.key);pending=null;received([...items.values()],null);
   }
  }catch(e){
   // Return only the exact article we opened, even when cancellation arrives.
   if(pending&&!returned){try{await call('return-article',{title:pending.title,url:pending.url},null);page=await profile(null);returned=true;pending=null;}catch{}}
   if(signal?.aborted)throw signal.reason||e;
   if(!items.size)throw e;
   return {source:'wechat-client',items:[...items.values()],complete:false,returnedToOriginalProfile:returned,clientPending:pending?.url||null,needsAction:true,action:'wechat-client'};
  }
  return {source:'wechat-client',items:[...items.values()],complete,returnedToOriginalProfile:returned,clientPending:null};
 }
}
