import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {externalApiSpec,externalPageFetch} from '../electron/external-account-api.js';
import {bilibiliRequest} from '../electron/bilibili-request.js';
import fs from 'node:fs';

const parseBody={type:'video_channel_url',url:'https://weixin.qq.com/sph/selected_public_work',scene:1};
test('浏览器API严格限定现有B站读取及视频号解析，不接受认证接口、写操作或凭据头',()=>{
  for(const [platform,url,options] of [
    ['B站','https://api.bilibili.com/x/web-interface/nav',{}],['B站','https://api.bilibili.com/x/web-interface/view?bvid=BV1qkYu63E7x',{}],
    ['视频号','https://yuanbao.tencent.com/api/weixin/get_parse_result',{method:'POST',body:JSON.stringify(parseBody)}],
    ['视频号','https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info',{method:'POST',body:JSON.stringify({baseReq:{generalToken:'selected-work-token'},exportId:'selected-work-id'})}]
  ]){const spec=externalApiSpec(platform,url,options);assert.equal(spec.url,url);assert.equal(spec.credentials,url.includes('channels.weixin')?'omit':'include');}
  for(const [platform,url,options] of [
    ['B站','https://api.bilibili.com/x/web-interface/nav',{headers:{Cookie:'must-not-pass'}}],['B站','https://api.bilibili.com/x/web-interface/nav',{headers:{Authorization:'must-not-pass'}}],
    ['B站','https://api.bilibili.com/x/web-interface/nav',{method:'POST',body:'{}'}],['B站','https://api.bilibili.com/x/member/web/account',{}],['B站','https://passport.bilibili.com/login',{}],['B站','https://api.bilibili.com/x/web-interface/nav?callback=steal',{}],['B站','https://api.bilibili.com.evil.invalid/x/web-interface/nav',{}],
    ['YouTube','https://api.bilibili.com/x/web-interface/nav',{}],['视频号','https://yuanbao.tencent.com/api/user/login',{method:'POST',body:'{}'}],['视频号','https://yuanbao.tencent.com/api/weixin/get_parse_result',{method:'POST',body:JSON.stringify({...parseBody,url:'https://evil.invalid/redirect'})}]
  ])assert.throws(()=>externalApiSpec(platform,url,options),/接口|凭据/);
});

test('真实浏览器内函数只返回状态与有大小上限的正文，凭据始终留给浏览器fetch处理',async()=>{
  const spec=externalApiSpec('B站','https://api.bilibili.com/x/web-interface/nav',{headers:{Origin:'https://space.bilibili.com',Referer:'https://space.bilibili.com/','User-Agent':'do-not-copy'}}),calls=[];
  const context={location:{origin:'https://www.bilibili.com'},URL,AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,fetch:async(url,options)=>{calls.push({url,options});return new Response('{"code":0,"data":{"isLogin":true}}',{headers:{'Set-Cookie':'not-exported','X-Private':'not-exported'}});}};vm.createContext(context);context.run=vm.runInContext('('+externalPageFetch.toString()+')',context);
  const response=await context.run(spec);assert.deepEqual(Object.keys(response).sort(),['ok','status','text']);assert.equal(response.status,200);assert.equal(calls[0].options.credentials,'include');assert.equal(calls[0].options.redirect,'error');assert.deepEqual(calls[0].options.headers,{Accept:'application/json'});assert.doesNotMatch(JSON.stringify(response),/not-exported|Set-Cookie|X-Private/);
  context.location.origin='https://evil.invalid';await assert.rejects(context.run(spec),/页面已跳转/);assert.equal(calls.length,1);
  context.location.origin='https://www.bilibili.com';context.fetch=async()=>new Response('response-too-long');await assert.rejects(context.run({...spec,maxBytes:4}),/响应过大/);
});

test('B站 confirmed external 经浏览器接口，旧native和匿名代理路径保持原有行为',async()=>{
  const calls=[],accounts={account:()=>({platform:'B站',loginBackend:'external-chrome'}),getSession(){throw Error('Must not read native session');},fetch:async(id,url,options)=>{calls.push({id,url,options});return {ok:true};}};
  const request=bilibiliRequest(accounts,()=>{throw Error('Must not use guest');});await request('https://api.bilibili.com/x/web-interface/nav',{accountId:'chrome'});assert.equal(calls[0].id,'chrome');assert.equal(calls[0].url,'https://api.bilibili.com/x/web-interface/nav');
});

test('视频号 confirmed external 请求走浏览器，旧native和64位作品数字处理保持不变',async()=>{
  const source=fs.readFileSync(new URL('../electron/wechat.js',import.meta.url),'utf8'),context={URL};vm.createContext(context);vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.WeChat=WeChat',context);
  const calls=[],response={ok:true,status:200,text:async()=>'{"id":12345678901234567890,"objectId":12345678901234567891}'};
  const controller=new AbortController();context.AbortSignal=AbortSignal;
  const accounts={account:()=>({loginBackend:'external-chrome'}),fetch:async(...args)=>{calls.push(['chrome',...args]);return response;},getSession(){return {fetch:async(...args)=>{calls.push(['native',...args]);return response;}};}};
  const wechat=new context.WeChat(accounts,'fixture');const result=await wechat.request('selected','https://yuanbao.tencent.com/api/weixin/get_parse_result',parseBody,true,controller.signal);assert.equal(result.id,'12345678901234567890');assert.equal(result.objectId,'12345678901234567891');assert.equal(calls[0][0],'chrome');assert.equal(calls[0][1],'selected');
  accounts.account=()=>({});await wechat.request('old','https://yuanbao.tencent.com/api/weixin/get_parse_result',parseBody,true,controller.signal);assert.equal(calls[1][0],'native');
});
