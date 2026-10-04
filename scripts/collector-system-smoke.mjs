// Scoped real Windows regression using only the application's existing public CA.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID,X509Certificate} from 'node:crypto';import {execFileSync,spawn} from 'node:child_process';
import {Store} from '../electron/store.js';import {CollectorConnection} from '../electron/collector-connection.js';
const output=path.resolve('output',`collector-system-${Date.now()}`),store=await Store.open(output,{}),directory=path.resolve(process.argv[2],'视频号连接'),certificateFile=path.join(directory,'local-certificate.pem');
const certificate=new X509Certificate(fs.readFileSync(certificateFile)),connection=new CollectorConnection(store,path.resolve('bin'),output,()=>{}),file=path.join(output,`lease-${randomUUID()}.json`),result={output,ok:false};
const roots=()=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$taskRoots=@{};foreach($scope in @('CurrentUser','LocalMachine')){$s=[Security.Cryptography.X509Certificates.X509Store]::new('Root',$scope);$s.Open(0);try{$taskRoots[$scope]=@($s.Certificates | Select-Object -ExpandProperty Thumbprint | Sort-Object)}finally{$s.Close()}};$taskRoots | ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8',timeout:10000}));
let before,trustedBefore,owner;
try {
  before=await connection.system('inspect');trustedBefore=roots();
  fs.writeFileSync(file,JSON.stringify({schema:1,id:randomUUID(),owner:process.pid,ownerStarted:before.ownerStarted,before:before.proxy,proxyAddress:'127.0.0.1:2023',certificateName:certificate.subject.match(/CN=([^\n]+)/)[1],certificateFile,certificateFingerprint:certificate.fingerprint256,certificateThumbprint:'',certificateAdded:false,phase:'prepared'}));
  const invalid=JSON.parse(fs.readFileSync(file));invalid.certificateFingerprint='incorrect';fs.writeFileSync(file,JSON.stringify(invalid));
  await assert.rejects(connection.runSystem('apply',file,AbortSignal.timeout(10000)),/证书检查失败/);
  assert.deepEqual((await connection.system('inspect')).proxy,before.proxy);assert.deepEqual(roots(),trustedBefore);result.mismatchedFingerprintRejected=true;
  invalid.certificateFingerprint=certificate.fingerprint256;
  if(process.argv.includes('--crash')) {
    owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
    const inspected=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('bin/collector/collector-system.ps1'),'-Action','inspect','-OwnerProcess',String(owner.pid)],{windowsHide:true,encoding:'utf8',timeout:10000}));
    invalid.owner=owner.pid;invalid.ownerStarted=inspected.ownerStarted;
  }
  fs.writeFileSync(file,JSON.stringify(invalid));
  await connection.startGuard(file);
  const started=Date.now();await connection.runSystem('apply',file,AbortSignal.timeout(10000));result.applyMs=Date.now()-started;
  assert.equal((await connection.system('inspect')).proxy.ProxyServer.value,'127.0.0.1:2023');
  const activeRoots=roots();assert.deepEqual(activeRoots.LocalMachine,trustedBefore.LocalMachine);
  assert.ok(activeRoots.CurrentUser.includes(certificate.fingerprint.replaceAll(':','')),'CA must be visible to standard Windows trust APIs');
  const restored=Date.now();
  if(owner){owner.kill();for(let i=0;i<40 && JSON.parse(fs.readFileSync(file)).phase!=='restored';i++)await new Promise(r=>setTimeout(r,250));assert.equal(JSON.parse(fs.readFileSync(file)).phase,'restored');result.deadOwnerAutomaticallyRecovered=true;}
  else await connection.runSystem('restore',file,AbortSignal.timeout(10000));result.restoreMs=Date.now()-restored;
  assert.deepEqual((await connection.system('inspect')).proxy,before.proxy);assert.deepEqual(roots(),trustedBefore);
  result.automaticTrustAndRemoval=true;result.originalProxyRestored=true;result.allOtherRootsPreserved=true;result.ok=true;
} catch(error) {result.error=error.message;process.exitCode=1;}
finally {owner?.kill();if(fs.existsSync(file))await connection.runSystem('restore',file,AbortSignal.timeout(10000)).catch(e=>result.cleanupError=e.message);store.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
