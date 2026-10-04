import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {Store} from '../electron/store.js';import {CollectorConnection} from '../electron/collector-connection.js';
const output=path.resolve('output',`collector-component-${Date.now()}`),store=await Store.open(output,{}),bin=path.resolve(process.argv[2] || 'bin');
const connection=new CollectorConnection(store,bin,path.join(output,'component'),()=>{}),result={output,ok:false,changedSecuritySettings:false};
const roots=()=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $taskRoots=@{};foreach($taskScope in @('CurrentUser','LocalMachine')){$taskStore=[Security.Cryptography.X509Certificates.X509Store]::new('Root',$taskScope);$taskStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly);try{$taskRoots[$taskScope]=@($taskStore.Certificates | Select-Object -ExpandProperty Thumbprint | Sort-Object)}finally{$taskStore.Close()}};$taskRoots | ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8'}));
try {
 const before=await connection.system('inspect'),trustedBefore=roots();await connection.prepare();const status=await connection.api('/api/proxy/status');
 assert.equal(Boolean(status.service?.listening),false);assert.equal(connection.status().allowed,false);assert.ok(connection.certificate.fingerprint);
 assert.deepEqual((await connection.system('inspect')).proxy,before.proxy);assert.deepEqual(roots(),trustedBefore);
 result.bundledServiceStarted=Boolean(connection.worker);result.publicCertificatePrepared=true;result.proxyUnchanged=true;result.trustStoresUnchanged=true;result.trustStoreCounts=Object.fromEntries(Object.entries(trustedBefore).map(([k,v])=>[k,v.length]));result.ok=true;
}catch(error){result.error=String(error.stack || error);process.exitCode=1;}
finally{await connection.close().catch(()=>{});store.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
