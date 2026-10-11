import { randomUUID } from 'node:crypto';
import { contentOptions, matchingContent, biliContent, wechatContent,mergeContent } from './content-data.js';
export class ContentSearch {
  constructor({accounts,creators,userSearch,bilibili,wechat,browser,changed=()=>{},store}){Object.assign(this,{accounts,creators,userSearch,bilibili,wechat,browser,changed,store});this.browser.hidden=true;const last=store.get('meta','lastContentSearch');this.record=last?store.get('content-search',last.id):null;if(this.record?.status==='searching')this.record.status='interrupted';this.active=null;}
  view(){if(!this.record)return null;const {accountId,next,all,...r}=this.record;return {...r,busy:!!this.active,items:matchingContent(all,r.options),unknown:all.filter(i=>!i.publishedAt).length,canContinue:['ready','needs-action','interrupted'].includes(r.status)};}
  publish(){if(!this.record)return;this.store.put('content-search',this.record.id,this.record);this.store.put('meta','lastContentSearch',{id:this.record.id});this.store.flush();this.changed();}
  show(){(this.actionBrowser||this.browser).show();}
  cancel(){const running=!!this.active;this.active?.abort();this.browser.close();this.detailBrowser?.close();this.actionBrowser?.close();this.actionBrowser=null;if(running&&this.record){this.record.status='interrupted';this.record.message='已停止，已有结果保留，可继续读取。';this.publish();}}
  async close(){this.cancel();await this.pending?.catch(()=>{});}
  async run(fn){if(this.active||this.creators.progress()||this.userSearch.active)throw new Error('正在搜索或读取作品，请先停止当前操作');const c=this.active=new AbortController();try{return await(this.pending=fn(c.signal));}catch(e){if(this.record){this.record.status='interrupted';this.record.message=c.signal.aborted?'已停止，已有结果保留，可继续读取。':e.message;this.store.put('content-search',this.record.id,this.record);this.store.put('meta','lastContentSearch',{id:this.record.id});this.store.flush();this.changed();}throw e;}finally{this.active=null;this.pending=null;this.changed();}}
  start(platform,keyword,options){const valid=contentOptions(platform,keyword,options);return this.run(async signal=>{
    if(platform==='B站')await this.creators.requireLogin(platform,signal);
    this.browser.close();this.actionBrowser?.close();this.actionBrowser=null;this.record={id:randomUUID(),platform,keyword:valid.keyword,options:valid,accountId:this.accounts.active(platform)?.id||null,all:[],next:platform==='B站'?1:'',status:'searching',message:'正在后台打开官方搜索，结果将逐批显示…',scanned:0,createdAt:Date.now()};this.publish();
    return platform==='视频号'?this.creators.connection.withConnection(signal,()=>this.read(signal,true)):this.read(signal,true);
  });}
  more(id){if(!this.record||id!==this.record.id||!this.view().canContinue)throw new Error('本次没有可继续读取的位置，请重新搜索');return this.run(signal=>this.record.platform==='视频号'?this.creators.connection.withConnection(signal,()=>this.read(signal)):this.read(signal));}
  async read(signal,initial=false){const r=this.record;const check=()=>{signal.throwIfAborted();if((this.accounts.active(r.platform)?.id||null)!==r.accountId)throw new Error('账号已切换，请重新搜索，避免混合不同账号的数据');};
    check();this.actionBrowser?.close();this.actionBrowser=null;r.status='searching';this.publish();let complete=false,needsAction=false,message='';const map=new Map(r.all.map(i=>[i.id,i]));
    const progress=page=>{if(signal.aborted||this.record!==r)return;check();for(const item of page.items||[])map.set(item.id,mergeContent(map.get(item.id),item));r.all=[...map.values()].slice(0,1000);r.scanned=r.all.length;r.message=page.message||`正在后台读取：已取得 ${r.scanned} 条，符合日期范围 ${matchingContent(r.all,r.options).length} 条…`;this.publish();};
    if(['小红书','抖音','YouTube'].includes(r.platform)){
      // One detail reader overlaps the list reader; no burst of parallel detail requests.
      let worker=null,detailError=null,listFailed=false;const checked=new Set();
      const detailBrowser=['小红书','YouTube'].includes(r.platform)&&typeof this.browser.detail==='function'?new this.browser.constructor(this.accounts):null;
      this.detailBrowser=detailBrowser;
      if(detailBrowser)detailBrowser.hidden=true;
      const pump=()=>{if(!detailBrowser||worker||needsAction||listFailed||signal.aborted)return;
        worker=(async()=>{for(;;){check();if(needsAction||listFailed||checked.size>=r.options.limit||matchingContent([...map.values()],r.options).length>=r.options.limit)break;
          const item=[...map.values()].find(i=>!i.publishedAt&&!checked.has(i.id));if(!item)break;checked.add(item.id);
          try{const detail=await detailBrowser.detail(item,r.accountId,signal,{metadataOnly:true,reuse:true});check();map.set(item.id,mergeContent(map.get(item.id),detail));}
          catch(e){if(signal.aborted)throw e;message='部分作品未能确认发布时间；日期未知的条目未计入时间范围。';if(/登录|验证|限制|429/.test(e.message)){needsAction=true;message=e.message;this.actionBrowser=detailBrowser;detailBrowser.show();}}
          progress({message:needsAction?message:`正在后台读取并确认日期：已读取 ${map.size} 条，符合条件 ${matchingContent([...map.values()],r.options).length} 条…`});
        }})().catch(e=>{detailError=e;}).finally(()=>{worker=null;});
      };
      const incremental=page=>{progress(page);if(page.needsAction)needsAction=true;if(!page.metadataPending)pump();return needsAction||matchingContent([...map.values()],r.options).length>=r.options.limit;};
      try{const page=await this.browser.read(r,signal,initial,incremental);check();progress(page);complete=page.complete;needsAction=needsAction||page.needsAction;message=needsAction?message||page.message:message||page.message;
        pump();while(worker)await worker;if(detailError)throw detailError;
      }catch(e){listFailed=true;detailBrowser?.close();throw e;}finally{if(worker)await worker;if(detailBrowser&&this.actionBrowser!==detailBrowser)detailBrowser.close();if(this.detailBrowser===detailBrowser)this.detailBrowser=null;}
    }else{
      for(let p=0;p<10;p++){
        check();let items,next;
        if(r.platform==='B站'){
          const data=await this.bilibili.json(`/x/web-interface/search/type?search_type=video&order=pubdate&keyword=${encodeURIComponent(r.keyword)}&page=${r.next}&page_size=20`,r.accountId,signal);
          if(!Array.isArray(data.result)||Number(data.page)!==r.next||!Number.isInteger(Number(data.numPages)))throw new Error('B站未返回有效作品分页，已有结果保留');
          items=data.result.map(biliContent).filter(Boolean);next=r.next<Number(data.numPages)?r.next+1:null;
        }else{
          const data=await this.wechat.request('/api/channels/contact/search',{keyword:'__fengsha_content__:'+JSON.stringify({query:r.keyword,requestId:randomUUID()}),next_marker:encodeURIComponent(r.next)},signal);
          if(data.fengshaVersion!==1||!Array.isArray(data.objectList))throw new Error('当前微信页面未加载作品搜索适配，请重新进入微信视频号页面后重试');
          items=data.objectList.map(wechatContent).filter(Boolean);const more=data.continueFlag??data.hasMore;next=more===0||more===false?null:data.lastBuff||data.lastBuffer||null;
          if(next&&next===r.next)throw new Error('微信没有返回新的作品分页，已停止重复读取');
        }
        check();const before=map.size;for(const item of items)map.set(item.id,item);
        if(next&&map.size===before)throw new Error('平台重复返回旧作品，清单与读取位置保留');
        r.next=next;complete=next===null;progress({});if(complete||matchingContent([...map.values()],r.options).length>=r.options.limit||map.size>=1000)break;
      }
    }
    check();r.all=[...map.values()].slice(0,1000);r.scanned=r.all.length;
    r.status=needsAction?'needs-action':matchingContent(r.all,r.options).length>=r.options.limit?'limited':complete?'complete':'ready';
    r.message=message||(r.status==='limited'?'已达到本次采集上限。':complete?'已读取至平台返回的末页。':'已获取一批作品，可继续读取。');
    this.store.put('content-search',r.id,r);this.store.put('meta','lastContentSearch',{id:r.id});this.store.flush();this.changed();return this.view();
  }
  item(recordId,itemId){const r=this.record?.id===recordId?this.record:this.store.get('content-search',recordId);const item=r?.all.find(i=>i.id===itemId);if(!item)throw new Error('作品记录不存在，请重新搜索');return {item,accountId:r.accountId};}
}
