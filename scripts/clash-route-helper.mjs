import fs from 'node:fs';
import {ClashRoute} from '../electron/clash-route.js';
async function restore(){try{
  const state=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if(state.schema!==1||state.mode!=='routed'||!state.routing?.directory)throw new Error('Invalid route lease');
  await new ClashRoute(state.routing.directory).restore(state.routing);
  console.log(JSON.stringify({restored:true}));
}catch{console.log(JSON.stringify({restored:false}));process.exitCode=1;}}
void restore();
