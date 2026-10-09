import {BrowserWindow} from 'electron';
import {platformOf,validSource} from './core.js';
import {contentLoadMessage} from './content-network.js';
import {contentNavigation} from './content-navigation.js';
export class SourceWindows{
  constructor(accounts,changed=()=>{}){this.accounts=accounts;this.changed=changed;this.windows=new Map();}
  open(value){const url=validSource(value),u=new URL(url),platform=platformOf(url);if(u.port)throw Error('原作品地址不能包含自定义端口');
    const existing=this.windows.get(url);if(existing&&!existing.isDestroyed()){existing.show();existing.focus();return {opened:true,message:'已显示原作品窗口'};}
    const account=this.accounts.active(platform),s=account?this.accounts.getSession(account.id):undefined;
    const w=new BrowserWindow({show:true,width:1120,height:820,autoHideMenuBar:true,title:`原作品 · ${platform}`,webPreferences:{session:s,partition:s?undefined:`fengsha-source-${platform}`,contextIsolation:true,sandbox:true,nodeIntegration:false}});this.windows.set(url,w);w.setMenu(null);w.webContents.setAudioMuted(true);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    let redirects=0,generation=0,stopped=false;w.on('close',()=>{stopped=true;});const load=next=>{const ticket=++generation;void w.loadURL(next,{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'}).catch(e=>{if(stopped||w.isDestroyed()||ticket!==generation)return;this.notice={id:Date.now(),message:'原作品打开失败：'+contentLoadMessage(e),error:true};this.changed();w.close();});};
    for(const event of ['will-navigate','will-redirect'])w.webContents.on(event,(e,next)=>{const rule=contentNavigation(next,url,platform);if(rule.upgrade){e.preventDefault();if(++redirects<=3)load(rule.upgrade);else{this.notice={id:Date.now(),message:'原作品页面重复跳转，请稍后重试',error:true};this.changed();w.close();}return;}try{validSource(next);const n=new URL(next);if(n.port||platformOf(next)!==platform)e.preventDefault();}catch{e.preventDefault();}});
    w.on('closed',()=>this.windows.delete(url));this.notice={id:Date.now(),message:'已打开独立原作品窗口',error:false};this.changed();
    w.show();w.focus();load(url);return {opened:true,message:'已打开独立原作品窗口'};
  }
  close(){for(const w of this.windows.values())if(!w.isDestroyed())w.close();this.windows.clear();}
}
