import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ManagedBrowser,browserCandidates,registeredBrowserCandidates,discoverBrowserCandidates} from '../electron/managed-browser.js';

function fixture(options={}){
  const directory=path.resolve('output','fixture-managed-browser');
  const chrome={name:'Chrome',kind:'chrome',executable:path.resolve('fixture-chrome.exe')};
  const edge={name:'Edge',kind:'edge',executable:path.resolve('fixture-edge.exe')};
  const files=new Set([chrome.executable,edge.executable]),calls=[];
  let active=null,ready=null,child;
  const manager=new ManagedBrowser({directory,candidates:[chrome,edge],exists:async file=>files.has(file),mkdir:async dir=>calls.push(['mkdir',dir]),
    spawnProcess(exe,args,spawnOptions){calls.push(['spawn',exe,args,spawnOptions]);child=new EventEmitter();child.unref=()=>{};child.kill=()=>{throw Error('Must not kill any browser');};active='ws://127.0.0.1:39117/devtools/browser/own-id';ready={available:true,reason:'ready',socketURL:active};return child;},
    readActivePort:async({file})=>{calls.push(['port',file]);return active;},readStatus:async options=>{calls.push(['status',options]);return ready||{available:false};},startTimeoutMs:20,pollMs:1,...options});
  return {manager,calls,files,directory,chrome,edge,setActive:(socket,status)=>{active=socket;ready=status;},child:()=>child};
}

test('installed browser candidates cover per-user and both Program Files locations with Chrome then Edge',()=>{
  const candidates=browserCandidates({LOCALAPPDATA:'C:\\Users\\fixture\\AppData\\Local',PROGRAMFILES:'C:\\Program Files','PROGRAMFILES(X86)':'C:\\Program Files (x86)'});
  assert.equal(candidates.length,6);assert.equal(candidates[0].kind,'chrome');assert.equal(candidates[3].kind,'edge');
  assert.ok(candidates.some(x=>x.executable.endsWith('Microsoft\\Edge\\Application\\msedge.exe')));
});

test('a status check is read-only; first use starts one background browser with a private persistent profile and dynamic loopback port',async()=>{
  const f=fixture();const before=await f.manager.status();assert.equal(before.canStart,true);assert.equal(before.reason,'prepared');assert.equal(f.calls.some(x=>x[0]==='spawn'||x[0]==='mkdir'),false);
  const [first,second]=await Promise.all([f.manager.ensure(),f.manager.ensure()]);assert.equal(first.available,true);assert.deepEqual(first,second);assert.equal(first.requiresApproval,false);
  const starts=f.calls.filter(x=>x[0]==='spawn');assert.equal(starts.length,1);const [,exe,args,options]=starts[0];assert.equal(exe,f.chrome.executable);
  assert.ok(args.includes('--user-data-dir='+path.join(f.directory,'chrome')));assert.ok(args.includes('--remote-debugging-port=0'));assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));assert.ok(args.includes('--no-startup-window'));assert.equal(options.windowsHide,true);
  assert.doesNotMatch(args.join(' '),/no-sandbox|disable-web-security|ignore-certificate|remote-allow-origins|proxy/);
  await f.manager.ensure();assert.equal(f.calls.filter(x=>x[0]==='spawn').length,1,'repeat open reuses the same browser');
});

test('Edge is discovered when Chrome is absent; existing Edge profile stays selected when Chrome is later available',async()=>{
  const f=fixture();f.files.delete(f.chrome.executable);assert.equal((await f.manager.ensure()).browserName,'Edge');
  const restarted=fixture();restarted.files.add(path.join(restarted.directory,'edge','Local State'));assert.equal((await restarted.manager.ensure()).browserName,'Edge');
});

test('a stale active port belonging to another browser is never reused',async()=>{
  const f=fixture();f.setActive('ws://127.0.0.1:39117/devtools/browser/old-id',{available:true,socketURL:'ws://127.0.0.1:39117/devtools/browser/foreign-id'});
  const ready=await f.manager.ensure();assert.match(ready.socketURL,/own-id$/);assert.equal(f.calls.filter(x=>x[0]==='spawn').length,1);
});

test('missing browser returns a useful installation message instead of IP or debugging configuration instructions',async()=>{
  const f=fixture();f.files.clear();const status=await f.manager.status();assert.equal(status.reason,'browser-missing');assert.equal(status.canStart,false);
  await assert.rejects(f.manager.ensure(),/请安装其中一种官方浏览器/);assert.equal(f.calls.some(x=>x[0]==='spawn'),false);
});

test('launch error and timeout are bounded and do not terminate unrelated browsers or touch a profile',async()=>{
  const errorFixture=fixture({spawnProcess(){const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('ENOENT')));return child;}});
  await assert.rejects(errorFixture.manager.ensure(),/未能启动/);
  const timed=fixture({readActivePort:async()=>null,startTimeoutMs:5});await assert.rejects(timed.manager.ensure(),/启动超时/);
  assert.ok(timed.calls.every(([method])=>!['delete','kill','copy'].includes(method)));
});

test('cancelling preparation releases the caller; a later use can reconnect without clearing login data',async()=>{
  let polls=0;
  const f=fixture({readActivePort:async()=>{polls++;return null;},startTimeoutMs:10000,pollMs:50});
  const pending=f.manager.ensure();while(polls<2)await new Promise(resolve=>setImmediate(resolve));f.manager.cancelPending();await assert.rejects(pending,/取消|abort/i);
  assert.equal(f.manager.starting,null);assert.equal(f.manager.controller,null);
});

test('registered custom browser locations preserve Chinese paths and reject commands or unrelated executables',async()=>{
  let invocation;
  const chrome=path.resolve('output','其他磁盘 浏览器','chrome.exe'),edge=path.resolve('output','Edge','msedge.exe');
  const candidates=await registeredBrowserCandidates({platform:'win32',env:{SystemRoot:'C:\\Windows'},run:async(...args)=>{invocation=args;return {stdout:JSON.stringify([
    {kind:'chrome',executable:'"'+chrome+'"'},{kind:'edge',executable:edge},
    {kind:'chrome',executable:chrome+' --unsafe'},{kind:'chrome',executable:'chrome.exe'},
    {kind:'chrome',executable:path.resolve('powershell.exe')},{kind:'unknown',executable:edge}
  ])};}});
  assert.deepEqual(candidates.map(c=>c.executable),[chrome,edge]);
  assert.equal(invocation[2].windowsHide,true);assert.equal(invocation[2].timeout,5000);
  assert.ok(invocation[1].includes('-NoProfile'));assert.ok(invocation[1].includes('-NonInteractive'));
  const script=Buffer.from(invocation[1].at(-1),'base64').toString('utf16le');
  assert.match(script,/OpenSubKey/);assert.doesNotMatch(script,/SetValue|CreateSubKey|DeleteSubKey|Invoke-WebRequest|Start-Process/);
});

test('registry failure keeps standard discovery usable and default paths are deduplicated',async()=>{
  assert.deepEqual(await registeredBrowserCandidates({platform:'win32',run:async()=>{throw Error('blocked');}}),[]);
  const env={LOCALAPPDATA:path.resolve('output','Local')},standard=browserCandidates(env)[0];
  const list=await discoverBrowserCandidates({env,registered:async()=>[{...standard,executable:standard.executable.toUpperCase()}]});
  assert.equal(list.length,2);assert.equal(list[0].executable,standard.executable);
});

test('missing default installations discover a registered custom browser and later retries can discover a newly installed one',async()=>{
  const custom={kind:'chrome',name:'Chrome',executable:path.resolve('output','自定义安装','chrome.exe')};
  let installed=false,discoveries=0;
  const f=fixture({candidates:undefined,discover:async()=>{discoveries++;return installed?[custom]:[];},exists:async file=>file===custom.executable});
  assert.equal((await f.manager.status()).reason,'browser-missing');
  installed=true;
  assert.equal((await f.manager.ensure()).browserName,'Chrome');
  assert.equal(f.calls.find(x=>x[0]==='spawn')[1],custom.executable);
  assert.equal(discoveries,2);
});

test('normal installed browsers avoid registry subprocesses entirely',async()=>{
  const standard=browserCandidates()[0];
  const f=fixture({candidates:undefined,discover:async()=>{throw Error('standard install should not query registry');},exists:async file=>file===standard.executable});
  assert.equal((await f.manager.status()).canStart,true);
});

test('a retained custom Chrome profile stays selected even while Edge exists in a standard location',async()=>{
  const standardEdge=browserCandidates().find(candidate=>candidate.kind==='edge');
  const custom={kind:'chrome',name:'Chrome',executable:path.resolve('output','自定义Chrome','chrome.exe')};
  const directory=path.resolve('output','fixture-managed-browser');
  let discoveries=0;
  const f=fixture({directory,candidates:undefined,discover:async()=>{discoveries++;return [custom];},
    exists:async file=>[standardEdge.executable,custom.executable,path.join(directory,'chrome','Local State')].includes(file)});
  assert.equal((await f.manager.ensure()).browserName,'Chrome');
  assert.equal(f.calls.find(call=>call[0]==='spawn')[1],custom.executable);
  assert.equal(discoveries,1);
});
