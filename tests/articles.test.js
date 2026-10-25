import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {articleURL,articleLinks,articleFiles,imageURL,articleRequest,articleIdentity} from '../electron/article-data.js';
import {Articles} from '../electron/articles.js';

const link='https://www.xiaohongshu.com/explore/abcdefabcdefabcdefabcdef?xsec_token=one';
test('article URL boundary and stable identity',()=>{
  for(const url of ['http://127.0.0.1/s/a','https://mp.weixin.qq.com.evil.com/s/a','https://u:p@mp.weixin.qq.com/s/a','file:///tmp/a','https://mp.weixin.qq.com:444/s/a','https://mp.weixin.qq.com/cgi-bin/home'])assert.throws(()=>articleURL(url));
  assert.equal(articleURL(link).id,articleURL(link.replace('one','two')).id);
  assert.equal(articleLinks(link+'\n'+link).length,1);
  assert.equal(articleURL('https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=s&scene=1').id,articleURL('https://mp.weixin.qq.com/s?mid=123&idx=1&sn=s&__biz=abc').id);
  assert.throws(()=>articleRequest({mode:'author',platform:'小红书',input:'https://evil.test'}));
  assert.throws(()=>articleRequest({mode:'search',platform:'公众号',input:'x',limit:Infinity}));
  const sourceIdentity={biz:'abc==',mid:'123',idx:'1'};
  assert.equal(articleIdentity({url:'https://mp.weixin.qq.com/s?signature=first',sourceIdentity}).id,articleIdentity({url:'https://mp.weixin.qq.com/s?signature=second',sourceIdentity}).id);
});
test('only approved image origins; exports cannot execute source HTML',()=>{
  assert.throws(()=>imageURL('https://127.0.0.1/a.png'));
  assert.throws(()=>imageURL('https://evil.test/a.png'));
  const files=articleFiles({title:'<script>x</script>',author:'A',url:link,blocks:[{type:'text',text:'<img src=x onerror=alert(1)>'},{type:'image',url:'https://mmbiz.qpic.cn/a'}]},[]);
  assert.match(files.html,/&lt;script&gt;/);assert.doesNotMatch(files.html,/<script>/);
  assert.match(files.html,/default-src 'none'/);assert.match(files.markdown,/&lt;img/);
});
function fixture(reader){
  const data=new Map(),store={list:k=>[...data.entries()].filter(([id])=>id.startsWith(k+':')).map(([,v])=>structuredClone(v)),get:(k,id)=>structuredClone(data.get(k+':'+id)||null),put:(k,id,v)=>data.set(k+':'+id,structuredClone(v)),flush(){}};
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fengsha-articles-'));
  return {store,directory,center:new Articles({store,directory,reader,changed(){}})};
}
const read=async url=>({...articleURL(url),title:'文章',author:'作者',blocks:[{type:'text',text:'真实正文'}],images:[]});
test('author collection refuses a same-name account with different biz',async()=>{
  const f=fixture({discover:async()=>({items:[articleURL(link)],authorContext:{name:'作者',biz:'correct'}}),read:async url=>({...await read(url),sourceIdentity:{biz:'wrong'}}),close(){}});
  try{await f.center.start({mode:'author',platform:'公众号',input:'作者'});await f.center.collect(f.center.view().discovery.items.map(i=>i.id));assert.equal(f.center.view().library.length,0);assert.match(f.center.view().discovery.items[0].error,/身份/);}finally{await f.center.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});
test('discovery requires selection, archives separate, repeat skips',async()=>{
  let calls=0;const f=fixture({read:async(...args)=>{calls++;return read(...args);},close(){}});
  try {await f.center.start({mode:'links',platform:'公众号',input:link});assert.equal(calls,1);assert.equal(f.center.view().library.length,0);assert.equal(fs.existsSync(f.directory+'/小红书'),false);assert.equal(f.center.view().discovery.items[0].title,'文章');await f.center.collect(f.center.view().discovery.items.map(x=>x.id));assert.equal(calls,2);assert.equal(f.center.view().library.length,1);await f.center.collect(f.center.view().discovery.items.map(x=>x.id));assert.equal(calls,2);assert.equal(f.store.list('media').length,0);fs.unlinkSync(path.join(f.center.view().library[0].directory,'article.md'));await f.center.collect(f.center.view().discovery.items.map(x=>x.id));assert.equal(calls,3);assert.ok(fs.existsSync(path.join(f.center.view().library[0].directory,'article.md')));}finally{await f.center.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});
test('image failures retain text as partial and retry can complete',async()=>{
  let fail=true;const f=fixture({read:async url=>({...await read(url),images:['https://mmbiz.qpic.cn/a'],blocks:[{type:'text',text:'正文'},{type:'image',url:'https://mmbiz.qpic.cn/a'}]}),image:async()=>{if(fail)throw Error('网络中断');return {bytes:Buffer.from('fixture'),ext:'png'};},close(){}});
  try {await f.center.start({mode:'links',input:link});const ids=f.center.view().discovery.items.map(x=>x.id);await f.center.collect(ids);assert.equal(f.center.view().library[0].status,'partial');fail=false;await f.center.collect(ids);assert.equal(f.center.view().library[0].status,'saved');}finally{await f.center.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});
test('cancel never saves a late response; next task is allowed',async()=>{
  let release;const f=fixture({read:(url,signal,options)=>options?.metadataOnly?read(url):new Promise(r=>release=r),close(){}});
  try {await f.center.start({mode:'links',input:link});const pending=f.center.collect(f.center.view().discovery.items.map(x=>x.id));await new Promise(r=>setImmediate(r));f.center.cancel();release(await read(link));await pending;assert.equal(f.center.view().library.length,0);assert.equal(f.center.view().busy,false);assert.equal(f.center.view().discovery.items[0].status,'cancelled');}finally{await f.center.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});
