import path from 'node:path';
import fs from 'node:fs';
import {execFile} from 'node:child_process';

// The native helper accepts fixed action names only, never URLs, PIDs, scripts or keys.
export class WeChatWindowHelper {
  constructor(bin,{execute=execFile,platform=process.platform,exists=fs.existsSync}={}){this.executable=path.join(bin,'collector','wechat-window-helper.exe');Object.assign(this,{execute,platform,exists});}
  inspect(signal){return this.run('inspect',signal);}
  refresh(signal){return this.run('refresh',signal);}
  async run(action,signal){
    signal?.throwIfAborted();if(!['inspect','refresh'].includes(action))throw Error('视频号窗口操作无效');
    if(this.platform!=='win32'||!this.exists(this.executable))return {ok:false,status:'unavailable',matched:0,refreshAttempted:false,refreshed:false};
    return new Promise((resolve,reject)=>this.execute(this.executable,[action],{windowsHide:true,timeout:10000,maxBuffer:65536,signal},(error,stdout)=>{
      if(signal?.aborted){reject(signal.reason||Error('CANCELLED'));return;}
      if(error){resolve({ok:false,status:error.killed?'timeout':'unavailable',matched:0,refreshAttempted:false,refreshed:false});return;}
      try{const value=JSON.parse(String(stdout).replace(/^\uFEFF/,''));const statuses=['found','not-found','ambiguous','changed','unsupported-document-query','unsupported-document-url','unsupported-document-owner','unsupported-toolbar','unsupported-menu','ambiguous-menu','unsupported-invoke','invoked','unavailable','invalid-action','timeout','scan-limited'];if(!value||typeof value.ok!=='boolean'||!statuses.includes(value.status)||!Number.isInteger(value.matched??0)||(value.matched??0)<0||value.refreshed===true&&(value.status!=='invoked'||value.matched!==1||value.refreshAttempted!==true))throw Error('Invalid native result');
        // Return only whitelisted fields; never forward unexpected native output.
        const result={ok:value.ok,status:value.status,matched:value.matched??0,refreshAttempted:value.refreshAttempted===true,refreshed:value.refreshed===true};
        for(const key of ['toolbarAvailable','menuOpened'])if(typeof value[key]==='boolean')result[key]=value[key];
        if(Number.isInteger(value.candidateDocuments)&&value.candidateDocuments>=0)result.candidateDocuments=value.candidateDocuments;
        if(Number.isInteger(value.nodesVisited)&&value.nodesVisited>=0)result.nodesVisited=value.nodesVisited;
        for(const key of ['toolbarAncestors','toolbarCandidates','moreCandidates','toolbarOwnerRejected'])if(Number.isInteger(value[key])&&value[key]>=0&&value[key]<=256)result[key]=value[key];
        if(['starting','process-filter','process-owner','process-signature','window-filter','window-properties','document-query','children','document-url','toolbar','menu','refresh-invoke'].includes(value.stage))result.stage=value.stage;
        if(value.url){const u=new URL(value.url);if(u.protocol!=='https:'||u.hostname!=='channels.weixin.qq.com'||u.username||u.password||u.port||!u.pathname.startsWith('/web/pages/'))throw Error('Unexpected window URL');result.url=u.origin+u.pathname;}
        resolve(result);
      }catch{resolve({ok:false,status:'invalid-result',matched:0,refreshAttempted:false,refreshed:false});}
    }));
  }
}
