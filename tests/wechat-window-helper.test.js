import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {execFileSync} from 'node:child_process';import path from 'node:path';
import {WeChatWindowHelper} from '../electron/wechat-window-helper.js';
const helper=(value,observe=()=>{})=>new WeChatWindowHelper('fixture-bin',{platform:'win32',exists:()=>true,execute:(exe,args,options,callback)=>{observe({exe,args,options});callback(null,JSON.stringify(value));}});
test('视频号窗口助手仅执行固定动作，不接受任意窗口、地址或按键；隐藏子进程并限制时间',async()=>{
 let call;const w=helper({ok:true,status:'found',matched:1,url:'https://channels.weixin.qq.com/web/pages/home?auth=NEVER_EXPORT',processId:1,secret:'NEVER_EXPORT'},v=>{call=v;});
 const result=await w.inspect();assert.deepEqual(call.args,['inspect']);assert.equal(call.options.windowsHide,true);assert.equal(call.options.timeout,10000);assert.equal(result.url,'https://channels.weixin.qq.com/web/pages/home');assert.ok(!JSON.stringify(result).includes('NEVER_EXPORT'));assert.ok(!('processId'in result));
 await w.refresh();assert.deepEqual(call.args,['refresh']);await assert.rejects(w.run('sendKeys'),/操作无效/);
});
test('视频号窗口不存在、重复匹配、工具栏不可调用时保留明确限制且不谎报已刷新',async()=>{
 for(const status of ['not-found','ambiguous','unsupported-document-query','unsupported-document-url','unsupported-document-owner','unsupported-toolbar','unsupported-menu','changed']){const r=await helper({ok:true,status,matched:status==='ambiguous'?2:0}).refresh();assert.equal(r.status,status);assert.equal(r.refreshed,false);}
 assert.equal((await new WeChatWindowHelper('fixture',{platform:'linux'}).inspect()).status,'unavailable');
});
test('停止后不启动窗口助手；非法结果及非官方地址不返回',async()=>{
 const c=new AbortController();c.abort();let called=false;await assert.rejects(helper({ok:true,status:'found'},()=>{called=true;}).inspect(c.signal));assert.equal(called,false);
 for(const url of ['https://channels.weixin.qq.com.evil.example/web/pages/home','http://channels.weixin.qq.com/web/pages/home','https://channels.weixin.qq.com/web/private','https://user:pass@channels.weixin.qq.com/web/pages/home'])assert.equal((await helper({ok:true,status:'found',matched:1,url}).inspect()).status,'invalid-result');
});
test('已编译原生助手仅执行自检，不访问真实窗口；校验官方URL和进程名白名单', {skip:process.platform!=='win32'||!fs.existsSync('bin/collector/wechat-window-helper.exe')},()=>{
 const result=JSON.parse(execFileSync(path.resolve('bin/collector/wechat-window-helper.exe'),['self-test'],{windowsHide:true,encoding:'utf8',timeout:5000}));assert.equal(result.ok,true);assert.equal(result.uiAccessed,false);assert.equal(result.status,'passed');assert.equal(result.threadModel,'MTA');assert.equal(result.ownershipChecks,6);
});
test('原生扫描超时或有界上限和未找到页面严格区分，不谎报不存在',async()=>{for(const status of ['timeout','scan-limited']){const result=await helper({ok:false,status,matched:0,stage:'children',nodesVisited:50}).inspect();assert.equal(result.status,status);assert.equal(result.stage,'children');assert.equal(result.refreshed,false);}});
test('只读按钮诊断仅返回有界计数和Invoke可用性，不返回UI树或其他控件文本',async()=>{const r=await helper({ok:true,status:'found',matched:1,toolbarAvailable:true,toolbarAncestors:8,toolbarCandidates:1,moreCandidates:1,toolbarOwnerRejected:0,tree:'NEVER_EXPORT',names:['NEVER_EXPORT'],unexpectedCount:99999}).inspect();assert.equal(r.toolbarAvailable,true);assert.equal(r.toolbarAncestors,8);assert.equal(r.moreCandidates,1);assert.ok(!JSON.stringify(r).includes('NEVER_EXPORT'));assert.equal(r.unexpectedCount,undefined);});
test('原生Document发现仅使用provider端三项精确条件，不遍历结构、读取其他节点或聊天',()=>{
 const source=fs.readFileSync('electron/wechat-window-helper.cs','utf8');const section=source.slice(source.indexOf('static List<Candidate> Candidates('),source.indexOf('static bool Revalidate('));
 assert.match(section,/ControlTypeProperty,ControlType\.Document/);assert.match(section,/NameProperty,"视频号"/);assert.match(section,/AutomationIdProperty,"RootWebArea"/);assert.match(section,/root\.FindAll\(TreeScope\.Descendants,documentCondition\)/);assert.doesNotMatch(section,/Walk\(root|Condition\.TrueCondition|TextPattern|GetText|TextContent|\.Value.*CommandLine/);assert.match(section,/DocumentOwner\(process,doc\.Current\.ProcessId\)/);assert.match(section,/DocumentURL\(doc,out path\)/);
});
