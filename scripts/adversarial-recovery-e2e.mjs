import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {build} from 'vite';

// Run the actual recovery UI against an independently built current renderer.
const root=path.resolve('.'),output=path.join(root,'output/repair-071/review-main',`recovery-${Date.now()}`),renderer=path.join(output,'renderer');
fs.mkdirSync(renderer,{recursive:true});
await build({root,logLevel:'warn',build:{outDir:path.join(renderer,'dist'),emptyOutDir:false}});
let script=fs.readFileSync(path.join(root,'scripts/content-recovery-e2e.mjs'),'utf8');
script=script.replace("from './test-renderer.mjs'",`from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/test-renderer.mjs')).href)}`);
script=script.replaceAll('await reloadTestRenderer(app)','await ownedRenderer(app)');
script=script.replace("path.resolve('output','content-recovery-'+Date.now())",JSON.stringify(output));
script=script.replace("result.error=e.stack;throw e;",`result.error=e.stack;if(app){const p=await app.firstWindow();fs.writeFileSync(path.join(output,'failure.html'),await p.content());await p.screenshot({path:path.join(output,'failure.png')});result.windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL()})));}throw e;`);
script+=`\nasync function ownedRenderer(application){const prior=process.cwd();try{process.chdir(${JSON.stringify(renderer)});await reloadTestRenderer(application);}finally{process.chdir(prior);}}\n`;
const runner=path.join(output,'runner.mjs');fs.writeFileSync(runner,script);
const child=spawn(process.execPath,[runner],{cwd:root,env:{...process.env},stdio:'inherit',windowsHide:true});
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
