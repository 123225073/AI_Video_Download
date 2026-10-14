import fs from 'node:fs';
import {ClashRoute} from '../electron/clash-route.js';
const maxLeaseBytes=1024*1024;
async function restore(){
  let stage='lease-read';
  try{
    const args=process.argv.slice(2);
    if(args.length!==1)throw new Error('Invalid helper arguments');
    let bytes;
    if(args[0]==='--stdin'){
      const chunks=[];let size=0;
      for await(const chunk of process.stdin){
        size+=chunk.length;
        if(size>maxLeaseBytes){stage='lease-size';throw new Error('Lease too large');}
        chunks.push(chunk);
      }
      bytes=Buffer.concat(chunks,size);
    }else{
      if(fs.statSync(args[0]).size>maxLeaseBytes){stage='lease-size';throw new Error('Lease too large');}
      bytes=fs.readFileSync(args[0]);
      if(bytes.length>maxLeaseBytes){stage='lease-size';throw new Error('Lease too large');}
    }
    stage='lease-parse';
    const state=JSON.parse(bytes.toString('utf8'));
    stage='lease-validate';
    if(!state||state.schema!==1||state.mode!=='routed'||typeof state.routing?.directory!=='string'||!state.routing.directory.trim())throw new Error('Invalid route lease');
    stage='route-restore';
    await new ClashRoute(state.routing.directory).restore(state.routing);
    console.log(JSON.stringify({restored:true}));
  }catch{console.log(JSON.stringify({restored:false,stage}));process.exitCode=1;}
}
void restore();
