import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
// Some managed Windows hosts expose encrypted file headers to Chromium while
// Node can read the same generated files. Keep this workaround in test code.
export async function reloadTestRenderer(application){
  const files={};const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
  function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())visit(file);else files[pathToFileURL(path.resolve(file)).href]={data:fs.readFileSync(file).toString('base64'),type:types[path.extname(file)]||'application/octet-stream'};}}visit('dist');
  const server=http.createServer((request,response)=>{const key=pathToFileURL(path.resolve('dist','.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname))).href;const file=files[key];if(!file){response.writeHead(404);response.end();return;}response.writeHead(200,{'content-type':file.type});response.end(Buffer.from(file.data,'base64'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();application.on('close',()=>server.close());
  const page=await application.firstWindow();await page.waitForLoadState('load');
  for(let i=0;i<100;i++){if(await application.evaluate(()=>globalThis.fengshaTest?.ready))break;await new Promise(r=>setTimeout(r,50));}
  await application.evaluate(({session})=>session.defaultSession.setProxy({mode:'direct'}));
  await application.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows()[0].loadURL(url),`http://127.0.0.1:${server.address().port}/index.html`);
}
