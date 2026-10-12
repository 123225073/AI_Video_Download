import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {contentDefaults,contentOptions,contentItem,matchingContent,xhsContent,douyinContent,biliContent,wechatContent} from '../electron/content-data.js';
import {ContentSearch} from '../electron/content-search.js';
import {createAgentHandler} from '../electron/agent.js';
const now=new Date('2026-10-09T12:00:00');
test('Agent作品搜索遇到登录验证应标记未完成，并隐藏详情正文和临时令牌',async()=>{
  const reply={id:'record',status:'needs-action',items:[{id:'abcdefabcdefabcdefabcdef',url:'https://www.xiaohongshu.com/explore/abcdefabcdefabcdefabcdef?xsec_token=test&xsec_source=pc_search',text:'原始正文',images:['https://sns-webpic.xhscdn.com/a.png'],bodyComplete:false}]};
  const handler=createAgentHandler({busy:()=>false,contentSearch:{start:async()=>reply}});const result=await handler({command:'notes',source:'AI',options:{platform:'小红书'}});assert.equal(result.partial,true);assert.equal(result.items[0].text,undefined);assert.equal(result.items[0].images,undefined);assert.equal(result.items[0].url.includes('xsec_token'),false);
});
test('最近一月按日历月计算并正确处理月末、闰年，数量日期严格校验',()=>{
  assert.deepEqual(contentDefaults(now),{limit:50,from:'2026-09-09',to:'2026-10-09',includeUnknown:false});assert.equal(contentDefaults(new Date('2024-03-31T12:00:00')).from,'2024-02-29');
  for(const options of [{limit:0},{limit:501},{limit:3.5},{from:'2026-02-30'},{from:'2026-10-10'},{to:'2026-10-11'}])assert.throws(()=>contentOptions('小红书','减肥',options,now));
});
test('每个平台作品ID与URL必须一致，不接收用户主页或伪造外域',()=>{
  for(const platform of ['小红书','抖音','B站','YouTube','视频号'])assert.equal(contentItem(platform,{id:'42',url:'https://evil.invalid',title:'x'}),null);
  assert.equal(contentItem('YouTube',{id:'abcdefghijk',url:'https://www.youtube.com/watch?v=other123456',title:'x'}),null);
  assert.equal(contentItem('小红书',{id:'abcdefabcdefabcdefabcdef',url:'https://www.xiaohongshu.com/user/profile/abcdefabcdefabcdefabcdef',title:'x'}),null);
});
test('搜索卡片与完整笔记分开，日期未知不冒充最近一月，平台图文正文与图片保持',()=>{
  const card=xhsContent({id:'abcdefabcdefabcdefabcdef',xsec_token:'T',note_card:{type:'normal',display_title:'减肥笔记',user:{nickname:'作者'},cover:{url_default:'https://sns-webpic.xhscdn.com/cover.png'}}});
  assert.equal(card.bodyComplete,false);assert.deepEqual(matchingContent([card],contentOptions('小红书','减肥',{},now)),[]);
  assert.equal(matchingContent([card],contentOptions('小红书','减肥',{includeUnknown:true},now)).length,1);
  const full=xhsContent({id:card.id,note_card:{type:'normal',title:'减肥笔记',desc:'第一段\n第二段',time:new Date('2026-10-01T12:00:00').getTime(),image_list:[{url_default:'https://sns-webpic.xhscdn.com/a.png'}]}});
  assert.equal(full.text,'第一段\n第二段');assert.equal(full.bodyComplete,true);assert.equal(full.images.length,1);assert.equal(matchingContent([full],contentOptions('小红书','减肥',{},now)).length,1);
});
test('抖音图文、B站时间、微信大整数与作品类型分别解析',()=>{
  const dy=douyinContent({aweme_id:'1234567890',desc:'正文',create_time:1790812800,author:{nickname:'作者'},images:[{url_list:['https://p3.douyinpic.com/a.png']}]});assert.equal(dy.type,'image');assert.match(dy.url,/\/note\//);
  assert.ok(biliContent({bvid:'BV1234567890',title:'<em>AI</em>教程',author:'作者',pic:'//i0.hdslb.com/a.jpg',pubdate:1790812800}).publishedAt);
  const wx=wechatContent({id:'18446744073709551615',objectNonceId:'1234',objectDesc:{description:'原始内容',media:[{}]},createtime:1790812800,contact:{nickname:'作者'}});assert.equal(wx.id,'18446744073709551615');assert.equal(wx.objectNonceId,'1234');
});
function searchFixture(response){const data=new Map();return new ContentSearch({accounts:{active:()=>({id:'same'})},creators:{progress:()=>null,requireLogin:async()=>{},connection:{withConnection:async(_s,fn)=>fn()}},userSearch:{active:null},bilibili:{json:response},wechat:{request:response},browser:{close(){},read:async()=>({items:[]})},store:{put:(kind,id,v)=>data.set(id,v),get:(_k,id)=>data.get(id),flush(){}},changed(){}});}
test('作品搜索获取多页、去重、严格数量上限与发布日期筛选',async()=>{
  const s=searchFixture(async url=>{const page=Number(new URL(url,'https://api.bilibili.com').searchParams.get('page'));return {page,numPages:3,result:Array.from({length:20},(_,i)=>({bvid:'BV'+String((page-1)*20+i).padStart(10,'0'),title:'作品',pubdate:new Date('2026-10-01T12:00:00').getTime()/1000}))};});
  const r=await s.start('B站','AI',{from:'2026-09-09',to:'2026-10-09'});assert.equal(r.items.length,50);assert.equal(r.scanned,60);assert.equal(r.canContinue,false);assert.equal(r.accountId,undefined);assert.equal(r.next,undefined);
});
test('缺少微信适配标志或缺少有效分页时不能显示搜索完成',async()=>{
  const s=searchFixture(async()=>({objectList:[],continueFlag:0}));await assert.rejects(s.start('视频号','AI',{from:'2026-09-09',to:'2026-10-09'}),/未加载作品搜索适配/);assert.equal(s.view().status,'interrupted');
});

test('微信作品使用官方objectContinueFlag与组合游标翻页，每批先显示且requestId稳定',async()=>{
  const requests=[],counts=[];const cursor='fengsha-page:'+JSON.stringify({offset:20,lastBuff:'next',requestId:'search'});
  const s=searchFixture(async(_url,p)=>{requests.push(p);return {fengshaVersion:1,objectList:[{id:String(requests.length),objectNonceId:'n',objectDesc:{description:'作品'+requests.length,media:[{}]},createtime:1790812800,contact:{nickname:'作者'}}],objectContinueFlag:requests.length===1?1:0,fengshaNextMarker:requests.length===1?cursor:null};});
  s.changed=()=>{if(s.view()?.items.length)counts.push(s.view().items.length);};
  const r=await s.start('视频号','AI',{from:'2026-09-09',to:'2026-10-09'});
  assert.equal(r.status,'complete');assert.equal(r.items.length,2);assert.ok(counts.includes(1));
  assert.equal(decodeURIComponent(requests[1].next_marker),cursor);
  const inputs=requests.map(p=>JSON.parse(p.keyword.slice(20)));assert.equal(inputs[0].requestId,inputs[1].requestId);assert.notEqual(inputs[0].nonce,inputs[1].nonce);
});

test('微信搜索取消后忽略晚到页面并保留已发布首批',async()=>{
  let release,started;const secondStarted=new Promise(r=>started=r);let n=0;
  const s=searchFixture(async()=>{n++;if(n===2){started();await new Promise(r=>release=r);}return {fengshaVersion:1,objectList:[{id:String(n),objectNonceId:'n',objectDesc:{description:'作品',media:[{}]},createtime:1790812800}],objectContinueFlag:n===1?1:0,lastBuff:'next'};});
  const running=s.start('视频号','AI',{from:'2026-09-09',to:'2026-10-09'});
  await secondStarted;assert.equal(s.view().items.length,1);s.cancel();release();await assert.rejects(running);
  assert.equal(s.view().items.length,1);assert.equal(s.view().status,'interrupted');assert.equal(s.view().canContinue,true);
});
test('同一微信API对象同时含评论、用户主页和搜索时，扩展仍能搜索并保留this与场景',async()=>{
  let listener;const calls=[],sent=[];const owner={finderGetCommentDetail(){},finderSearch:async function(p){assert.equal(this,owner);calls.push(p);return {errCode:0,data:{objectList:[],continueFlag:0}};}};
  const sandbox={window:{},WXU:{API:owner,onAPILoaded(fn){listener=fn;}},ws_client$:{methods:{__wx_handle_api_call:async()=>{throw new Error('其他分支失败');}}},setInterval,clearInterval,setTimeout};vm.createContext(sandbox);vm.runInContext(fs.readFileSync('electron/collector-content.js','utf8'),sandbox);
  await sandbox.ws_client$.methods.__wx_handle_api_call({id:'one',key:'key:channels:contact_list',data:{keyword:'__fengsha_content__:'+JSON.stringify({query:'减肥',requestId:'nonce'}),next_marker:''}},{readyState:1,send:v=>sent.push(JSON.parse(v))});
  assert.equal(calls[0].query,'减肥');assert.equal(calls[0].scene,19);assert.equal(sent[0].data.data.fengshaVersion,1);
  await sandbox.ws_client$.methods.__wx_handle_api_call({id:'two',key:'other',data:{}},{readyState:1,send:v=>sent.push(JSON.parse(v))});assert.equal(sent[1].data.errCode,1011);
  assert.equal(typeof listener,'function');
});
