import { randomUUID } from 'node:crypto';
import { contentOptions, matchingContent, biliContent, wechatContent,mergeContent } from './content-data.js';
const actionablePlatforms=['小红书','抖音','YouTube','B站'];
function recoveryAction(raw,message,{required=false}={}){
  const text=String(raw?.message||message||'请在官方窗口检查页面后继续。').slice(0,1000);
  let kind=['login','verification','network','page'].includes(raw?.kind)?raw.kind:null;
  if(!kind){
    if(/验证码|安全验证|访问受限|安全限制|登录或验证|设备登录超限/.test(text))kind='verification';
    else if(/登录/.test(text))kind='login';
    else if(/LOAD_FAILED|ERR_|网络|连接失败|连接超时/.test(text))kind='network';
    else if(required)kind='page';
  }
  return kind?{id:randomUUID(),kind,message:text,retryable:raw?.retryable===true||kind==='network',label:String(raw?.label||'打开官方窗口').slice(0,80),dismissed:false}:null;
}
export class ContentSearch {
  constructor({accounts,creators,userSearch,bilibili,wechat,browser,changed=()=>{},store}){Object.assign(this,{accounts,creators,userSearch,bilibili,wechat,browser,changed,store});this.browser.hidden=true;const last=store.get('meta','lastContentSearch');this.record=last?store.get('content-search',last.id):null;if(this.record?.status==='searching')this.record.status='interrupted';if(this.record&&!this.record.action&&actionablePlatforms.includes(this.record.platform)&&['needs-action','interrupted'].includes(this.record.status))this.record.action=recoveryAction(null,this.record.message,{required:this.record.status==='needs-action'});if(this.record?.action){this.record.action={...this.record.action,dismissed:true};this.record.status='needs-action';}this.active=null;}
  view(){if(!this.record)return null;const {accountId,next,all,dateChecked,listComplete,browserScroll,...r}=this.record;return {...r,busy:!!this.active,items:matchingContent(all,r.options),unknown:all.filter(i=>!i.publishedAt).length,canContinue:['ready','needs-action','interrupted'].includes(r.status)};}
  publish(){if(!this.record)return;this.store.put('content-search',this.record.id,this.record);this.store.put('meta','lastContentSearch',{id:this.record.id});this.store.flush();this.changed();}
  show(){(this.actionBrowser||this.browser).show();}
  cancel({preserveAction=false}={}){const running=!!this.active;this.active?.abort();this.actionController?.abort();this.actionEpoch=(this.actionEpoch||0)+1;if(this.browser.pause)this.browser.pause();else this.browser.close();this.detailBrowser?.close();this.actionBrowser?.close();this.actionBrowser=null;if((running||this.record?.action)&&this.record){if(preserveAction&&!running&&this.record.action)this.record.action={...this.record.action,dismissed:true};else{this.record.status='interrupted';this.record.action=null;this.record.message='已停止，已有结果保留，可继续读取。';}this.publish();}}
  async close(){this.cancel({preserveAction:true});await this.pending?.catch(()=>{});await this.actionPending?.catch(()=>{});this.browser.close();}
  async action(id,command){
    if(!this.record||this.record.id!==id||!this.record.action||!['open','check','dismiss','review'].includes(command))throw Error('本次没有待处理的官方页面，请继续读取或重新搜索');
    const r=this.record,actionId=r.action.id;
    if(command==='dismiss'){this.actionController?.abort();this.actionEpoch=(this.actionEpoch||0)+1;r.action={...r.action,dismissed:true};this.publish();return {dismissed:true};}
    if(command==='review'){r.action={...r.action,dismissed:false};this.publish();return {review:true};}
    if(this.active)throw Error('正在读取作品，请等待当前读取结束');
    if(this.actionPending)return this.actionPending;
    const epoch=this.actionEpoch||0,controller=this.actionController=new AbortController(),browser=this.actionBrowser||this.browser;
    this.actionPending=(async()=>{
      let result;
      if(r.platform==='B站'){
        if(command==='open'){r.action={...r.action,awaitingAccount:true};result={ready:false,manageAccount:true,message:'请在账号管理完成 B站登录，返回作品搜索后会检测并继续本次搜索。'};}
        else {try{await this.creators.requireLogin('B站',controller.signal);if(r.all.length&&(this.accounts.active('B站')?.id||null)!==r.accountId)result={ready:false,message:'当前账号与已有作品不同，已保留原结果，请重新搜索。'};else result={ready:true};}catch(error){if(controller.signal.aborted)throw error;result={ready:false,message:error.message};}}
      }else if(command==='open'){
        if(typeof browser.openAction==='function')result=await browser.openAction(r,controller.signal);
        else {await browser.show();result={ready:false,message:'请在官方窗口完成页面要求后返回。'};}
      }else result=typeof browser.checkAction==='function'?await browser.checkAction(r,controller.signal):{ready:false,message:'请在官方窗口完成页面要求后点击继续读取。'};
      if(controller.signal.aborted||this.record!==r||(this.actionEpoch||0)!==epoch||r.action?.id!==actionId)return {ready:false,cancelled:true};
      if(command==='open')r.action={...r.action,dismissed:false};
      if(result?.action)r.action={...r.action,...recoveryAction(result.action,result.message,{required:true}),id:actionId,dismissed:false};
      if(result?.message)r.message=String(result.message).slice(0,1000);
      this.publish();return {...result,ready:result?.ready===true};
    })().finally(()=>{this.actionPending=null;if(this.actionController===controller)this.actionController=null;});
    return this.actionPending;
  }
  async run(fn){if(this.active||this.actionPending||this.creators.progress()||this.userSearch.active)throw new Error('正在搜索或读取作品，请先停止当前操作');const c=this.active=new AbortController();try{return await(this.pending=fn(c.signal));}catch(e){if(this.record){this.record.action=!c.signal.aborted&&actionablePlatforms.includes(this.record.platform)?recoveryAction(e.action,e.message):null;this.record.status=this.record.action?'needs-action':'interrupted';this.record.message=c.signal.aborted?'已停止，已有结果保留，可继续读取。':e.message;this.store.put('content-search',this.record.id,this.record);this.store.put('meta','lastContentSearch',{id:this.record.id});this.store.flush();this.changed();}throw e;}finally{this.active=null;this.pending=null;this.changed();}}
  start(platform,keyword,options){const valid=contentOptions(platform,keyword,options);return this.run(async signal=>{
    this.browser.close();this.actionBrowser?.close();this.actionBrowser=null;this.record={id:randomUUID(),platform,keyword:valid.keyword,options:valid,accountId:this.accounts.active(platform)?.id||null,all:[],next:platform==='B站'?1:'',status:'searching',message:'正在后台打开官方搜索，结果将逐批显示…',scanned:0,createdAt:Date.now()};this.publish();
    if(platform==='B站')await this.creators.requireLogin(platform,signal);
    return platform==='视频号'?this.creators.connection.withConnection(signal,()=>this.read(signal,true),['search']):this.read(signal,true);
  });}
  more(id){if(!this.record||id!==this.record.id||!this.view().canContinue)throw new Error('本次没有可继续读取的位置，请重新搜索');return this.run(async signal=>{
    if(this.record.platform==='B站'){
      await this.creators.requireLogin('B站',signal);
      if(!this.record.all.length&&this.record.action?.kind==='login')this.record.accountId=this.accounts.active('B站')?.id||null;
    }
    return this.record.platform==='视频号'?this.creators.connection.withConnection(signal,()=>this.read(signal),['search']):this.read(signal);
  });}
  async read(signal,initial=false){const r=this.record;const check=()=>{signal.throwIfAborted();if((this.accounts.active(r.platform)?.id||null)!==r.accountId)throw new Error('账号已切换，请重新搜索，避免混合不同账号的数据');};
    check();this.actionBrowser?.close();this.actionBrowser=null;r.status='searching';r.action=null;this.publish();let complete=false,needsAction=false,message='',action=null;const map=new Map(r.all.map(i=>[i.id,i]));
    const progress=page=>{if(signal.aborted||this.record!==r)return;check();for(const item of page.items||[])map.set(item.id,mergeContent(map.get(item.id),item));r.all=[...map.values()];r.scanned=r.all.length;r.message=page.message||`正在后台读取：已取得 ${r.scanned} 条，符合日期范围 ${matchingContent(r.all,r.options).length} 条…`;this.publish();};
    if(['小红书','抖音','YouTube'].includes(r.platform)){
      // One detail reader overlaps the list reader; no burst of parallel detail requests.
      let worker=null,detailError=null,listFailed=false,attempts=0;const checked=new Set(r.dateChecked||[]);
      // Continue with untried notes before retrying a failed prefix, also after restart.
      if(![...map.values()].some(i=>!i.publishedAt&&!checked.has(i.id)))checked.clear();
      const detailBrowser=['小红书','YouTube'].includes(r.platform)&&typeof this.browser.detail==='function'?new this.browser.constructor(this.accounts):null;
      this.detailBrowser=detailBrowser;
      if(detailBrowser)detailBrowser.hidden=true;
      const pump=()=>{if(!detailBrowser||worker||needsAction||listFailed||signal.aborted)return;
        worker=(async()=>{for(;;){check();if(needsAction||listFailed||r.options.includeUnknown||attempts>=r.options.limit||matchingContent(map.values(),r.options).length>=r.options.limit)break;
          const item=[...map.values()].find(i=>!i.publishedAt&&!checked.has(i.id));if(!item)break;checked.add(item.id);attempts++;r.dateChecked=[...checked];
          try{const detail=await detailBrowser.detail(item,r.accountId,signal,{metadataOnly:true,reuse:true});check();map.set(item.id,mergeContent(map.get(item.id),detail));}
          catch(e){if(signal.aborted)throw e;message='部分作品未能确认发布时间；日期未知的条目未计入时间范围。';if(e.action||/登录|验证|限制|429/.test(e.message)){needsAction=true;message=e.message;action=e.action;this.actionBrowser=detailBrowser;detailBrowser.show();}}
          progress({message:needsAction?message:`正在后台读取并确认日期：已读取 ${map.size} 条，符合条件 ${matchingContent([...map.values()],r.options).length} 条…`});
        }})().catch(e=>{detailError=e;}).finally(()=>{worker=null;});
      };
      const incremental=page=>{progress(page);if(page.needsAction){needsAction=true;message=page.message||message;action=page.action||action;}if(!page.metadataPending)pump();return needsAction||matchingContent(map.values(),r.options).length>=r.options.limit;};
      try{const page=r.listComplete?{items:[],complete:true}:await this.browser.read(r,signal,initial,incremental);check();progress(page);complete=page.complete;r.listComplete=!!complete;if(page.needsAction){needsAction=true;message=page.message||message;action=page.action||action;}else message=message||page.message;
        pump();while(worker)await worker;if(detailError)throw detailError;
        if(!needsAction&&detailBrowser&&!r.options.includeUnknown&&matchingContent(map.values(),r.options).length<r.options.limit&&[...map.values()].some(i=>!i.publishedAt)){complete=false;message=r.listComplete?'作品列表已读到末页；部分发布时间待确认，可继续补查，日期未知条目未计入时间范围。':'部分发布时间待确认，可继续读取并补查，日期未知条目未计入时间范围。';}
      }catch(e){listFailed=true;detailBrowser?.close();throw e;}finally{if(worker)await worker;if(detailBrowser&&this.actionBrowser!==detailBrowser)detailBrowser.close();if(this.detailBrowser===detailBrowser)this.detailBrowser=null;}
    }else{
      for(let p=0;p<10;p++){
        check();let items,next;
        if(r.platform==='B站'){
          const data=await this.bilibili.json(`/x/web-interface/search/type?search_type=video&order=pubdate&keyword=${encodeURIComponent(r.keyword)}&page=${r.next}&page_size=20`,r.accountId,signal);
          if(!Array.isArray(data.result)||Number(data.page)!==r.next||!Number.isInteger(Number(data.numPages)))throw new Error('B站未返回有效作品分页，已有结果保留');
          items=data.result.map(biliContent).filter(Boolean);next=r.next<Number(data.numPages)?r.next+1:null;
        }else{
          const data=await this.wechat.request('/api/channels/contact/search',{keyword:'__fengsha_content__:'+JSON.stringify({query:r.keyword,requestId:r.id,nonce:randomUUID()}),next_marker:encodeURIComponent(r.next)},signal);
          if(data.fengshaVersion!==1||!Array.isArray(data.objectList))throw new Error('当前微信页面未加载作品搜索适配，请重新进入微信视频号页面后重试');
          items=data.objectList.map(raw=>{const item=wechatContent(raw);if(item)this.wechat.remember?.(raw);return item;}).filter(Boolean);const more=data.objectContinueFlag??data.continueFlag??data.hasMore;
          if(![0,1,false,true].includes(more))throw new Error('微信未返回明确的作品分页状态，已有结果保留');
          next=more===0||more===false?null:data.fengshaNextMarker||data.lastBuff||data.lastBuffer||null;
          if((more===1||more===true)&&!next)throw new Error('微信未返回下一页位置，已有结果保留');
          if(next&&next===r.next)throw new Error('微信没有返回新的作品分页，已停止重复读取');
        }
        check();const before=map.size;for(const item of items)map.set(item.id,mergeContent(map.get(item.id),item));
        if(next&&map.size===before)throw new Error('平台重复返回旧作品，清单与读取位置保留');
        r.next=next;complete=next===null;progress({});if(complete||matchingContent(map.values(),r.options).length>=r.options.limit)break;
      }
    }
    check();r.all=[...map.values()];r.scanned=r.all.length;
    r.status=needsAction?'needs-action':matchingContent(r.all,r.options).length>=r.options.limit?'limited':complete?'complete':'ready';
    r.message=message||(r.status==='limited'?'已达到本次采集上限。':complete?'已读取至平台返回的末页。':'已获取一批作品，可继续读取。');
    r.action=needsAction&&actionablePlatforms.includes(r.platform)?recoveryAction(action,r.message,{required:true}):null;
    this.store.put('content-search',r.id,r);this.store.put('meta','lastContentSearch',{id:r.id});this.store.flush();this.changed();return this.view();
  }
  item(recordId,itemId){const r=this.record?.id===recordId?this.record:this.store.get('content-search',recordId);const item=r?.all.find(i=>i.id===itemId);if(!item)throw new Error('作品记录不存在，请重新搜索');return {item,accountId:r.accountId};}
}
