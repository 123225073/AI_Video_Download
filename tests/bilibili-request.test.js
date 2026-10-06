import test from 'node:test';
import assert from 'node:assert/strict';
import { bilibiliRequest } from '../electron/bilibili-request.js';

test('匿名直连清单使用无凭据请求，代理和登录账号保留原会话路径', async () => {
  const calls=[];let proxy='DIRECT';
  const session={resolveProxy:async()=>proxy,getUserAgent:()=> 'Mozilla/5.0 fengsha-video-downloader/0.4.1 Chrome/144.0 Electron/40.0',fetch:async(_url,options)=>{calls.push({transport:'electron',options});return {};}};
  const accounts={account:()=>({platform:'B站'}),getSession:()=>session};
  const request=bilibiliRequest(accounts,()=>session,async(_url,options)=>{calls.push({transport:'node',options});return {};});
  const url='https://api.bilibili.com/x/space/wbi/arc/search?mid=31321989';
  await request(url,{headers:{Referer:'https://space.bilibili.com/','User-Agent':'Mozilla/5.0'}});
  assert.equal(calls[0].transport,'node');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');
  proxy='PROXY 127.0.0.1:9999; DIRECT';await request(url,{headers:{}});assert.equal(calls[1].transport,'electron');
  proxy='DIRECT';await request(url,{accountId:'bili',headers:{}});assert.equal(calls[2].transport,'electron');assert.equal(calls[2].options.credentials,'include');assert.ok(!calls[2].options.headers['User-Agent'].includes('Electron'));
});

test('拒绝外域和跨平台账号；代理解析期间取消不会发出请求', async () => {
  let sent=0,finish;const controller=new AbortController();
  const session={resolveProxy:()=>new Promise(r=>finish=r),fetch:async()=>sent++};
  const request=bilibiliRequest({account:()=>({platform:'YouTube'})},()=>session,async()=>sent++);
  await assert.rejects(request('https://api.bilibili.com.evil.example/x',{headers:{}}),/地址/);
  await assert.rejects(request('https://api.bilibili.com/x',{accountId:'youtube',headers:{}}),/账号/);
  const pending=request('https://api.bilibili.com/x/space/wbi/arc/search',{signal:controller.signal,headers:{}});
  controller.abort();finish('DIRECT');await assert.rejects(pending);assert.equal(sent,0);
});
