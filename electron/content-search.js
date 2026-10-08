import { randomUUID } from 'node:crypto';
import { contentOptions, matchingContent, biliContent, wechatContent } from './content-data.js';
export class ContentSearch {
  constructor({accounts,creators,userSearch,bilibili,wechat,browser,changed=()=>{},store}){Object.assign(this,{accounts,creators,userSearch,bilibili,wechat,browser,changed,store});const last=store.get('meta','lastContentSearch');this.record=last?store.get('content-search',last.id):null;if(this.record?.status==='searching')this.record.status='interrupted';this.active=null;}
  view(){if(!this.record)return null;const {accountId,next,all,...r}=this.record;return {...r,busy:!!this.active,items:matchingContent(all,r.options),unknown:all.filter(i=>!i.publishedAt).length,canContinue:['ready','needs-action','interrupted'].includes(r.status)};}
  cancel(){this.active?.abort();this.browser.close();}
  async close(){this.cancel();await this.pending?.catch(()=>{});}
  async run(fn){if(this.active||this.creators.progress()||this.userSearch.active)throw new Error('正在搜索或读取作品，请先停止当前操作');const c=this.active=new AbortController();this.changed();try{return await(this.pending=fn(c.signal));}catch(e){if(this.record){this.record.status='interrupted';this.record.message=c.signal.aborted?'已停止，已有结果保留，可继续读取。':e.message;this.store.put('content-search',this.record.id,this.record);this.store.put('meta','lastContentSearch',{id:this.record.id});this.store.flush();this.changed();}throw e;}finally{this.active=null;this.pending=null;this.changed();}}
  start(platform,keyword,options){const valid=contentOptions(platform,keyword,options);return this.run(async signal=>{
    if(platform==='B站')await this.creators.requireLogin(platform,signal);
    this.browser.close();this.record={id:randomUUID(),platform,keyword:valid.keyword,options:valid,accountId:this.accounts.active(platform)?.id||null,all:[],next:platform==='B站'?1:'',status:'searching',message:'',scanned:0,createdAt:Date.now()};
    return platform==='视频号'?this.creators.connection.withConnection(signal,()=>this.read(signal,true)):this.read(signal,true);
  });}
  more(id){if(!this.record||id!==this.record.id||!this.view().canContinue)throw new Error('本次没有可继续读取的位置，请重新搜索');return this.run(signal=>this.record.platform==='视频号'?this.creators.connection.withConnection(signal,()=>this.read(signal)):this.read(signal));}
  async read(signal,initial=false){const r=this.record;const check=()=>{signal.throwIfAborted();if((this.accounts.active(r.platform)?.id||null)!==r.accountId)throw new Error('账号已切换，请重新搜索，避免混合不同账号的数据');};
    check();let complete=false,needsAction=false,message='';const map=new Map(r.all.map(i=>[i.id,i]));
    if(['小红书','抖音','YouTube'].includes(r.platform)){
      const page=await this.browser.read(r,signal,initial);check();for(const item of page.items)map.set(item.id,item);complete=page.complete;needsAction=page.needsAction;message=page.message;
      // Publication time is in the note detail, not necessarily the search card.
      if(r.platform==='小红书'&&!needsAction){
        const unknown=[...map.values()].filter(i=>!i.publishedAt).slice(0,r.options.limit);
        const detailBrowser=new this.browser.constructor(this.accounts);detailBrowser.hidden=true;
        try{for(const item of unknown){check();if(matchingContent([...map.values()],r.options).length>=r.options.limit)break;
          try{const detail=await detailBrowser.detail(item,r.accountId,signal);map.set(item.id,{...item,...detail});}
          catch(e){if(signal.aborted)throw e;message='部分笔记未能确认发布时间；日期未知的条目未计入时间范围。';break;}
        }}finally{detailBrowser.close();}
      }
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
        r.next=next;complete=next===null;if(complete||matchingContent([...map.values()],r.options).length>=r.options.limit||map.size>=1000)break;
        r.all=[...map.values()];r.scanned=map.size;this.changed();
      }
    }
    check();r.all=[...map.values()].slice(0,1000);r.scanned=r.all.length;
    r.status=needsAction?'needs-action':matchingContent(r.all,r.options).length>=r.options.limit?'limited':complete?'complete':'ready';
    r.message=message||(r.status==='limited'?'已达到本次采集上限。':complete?'已读取至平台返回的末页。':'已获取一批作品，可继续读取。');
    this.store.put('content-search',r.id,r);this.store.put('meta','lastContentSearch',{id:r.id});this.store.flush();this.changed();return this.view();
  }
  item(recordId,itemId){const r=this.record?.id===recordId?this.record:this.store.get('content-search',recordId);const item=r?.all.find(i=>i.id===itemId);if(!item)throw new Error('作品记录不存在，请重新搜索');return {item,accountId:r.accountId};}
}
