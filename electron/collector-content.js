// Runs through the upstream's supported inject.globalScript extension.
// Search the exported objects by capability; the upstream's exclusive API groups
// can miss a function when WeChat merges modules. Never change the official function.
(() => {
  if(window.__fengshaContentInstalled)return;window.__fengshaContentInstalled=true;
  const registry=new Map(),subscribed=new WeakSet(),modules=new Map();
  const capture=variables=>{for(const methods of Object.values(variables||{})){if(!methods||!['object','function'].includes(typeof methods))continue;for(const name of ['finderSearch','finderUserPage','finderGetCommentDetail'])if(typeof methods[name]==='function')registry.set(name,{owner:methods,fn:methods[name]});}};
  const refresh=()=>{
    if(typeof WXU==='undefined')return;
    capture({a:WXU.API,b:WXU.API2,c:WXU.API3,d:WXU.API4});
    if(typeof WXU.onAPILoaded==='function'&&!subscribed.has(WXU)){WXU.onAPILoaded(capture);subscribed.add(WXU);}
  };
  // A cached ES module does not replay the interceptor's APILoaded event. Import
  // the exact URL already used by this page to recover its existing singleton.
  // Never guess a bundle version, evaluate source text, or import arbitrary URLs.
  const recoverModules=()=>{
    const urls=[];
    if(typeof performance!=='undefined')for(const e of performance.getEntriesByType('resource'))urls.push(e.name);
    if(typeof document!=='undefined')for(const e of document.querySelectorAll('script[type="module"][src],link[rel="modulepreload"][href]'))urls.push(e.src||e.href);
    for(const raw of urls.reverse()){
      let url;try{const u=new URL(raw);if(u.protocol!=='https:'||u.hostname!=='res.wx.qq.com'||u.port||u.username||u.password||u.hash||!/^\/t\/wx_fed\/finder\/web\/web-finder\/res\/js\/virtual_svg-icons-register\.publish[\w-]+\.js$/.test(u.pathname))continue;url=u.href;}catch{continue;}
      if(modules.has(url)||modules.size>=4)continue;
      modules.set(url,'loading');
      import(url).then(exports=>{capture(exports);modules.set(url,'loaded');},()=>modules.set(url,'failed'));
    }
  };
  refresh();
  const wait=async name=>{for(let i=0;i<20;i++){refresh();const found=registry.get(name);if(found)return found;recoverModules();await new Promise(r=>setTimeout(r,200));}return registry.get(name)||null;};
  const attach=()=>{
    if(typeof ws_client$==='undefined'||!ws_client$.methods||ws_client$.methods.__fengshaWrapped)return false;
    const methods=ws_client$.methods,old=methods.__wx_handle_api_call;methods.__fengshaWrapped=true;
    methods.__wx_handle_api_call=async function(msg,socket){
      const send=data=>{if(socket.readyState===1)socket.send(JSON.stringify({id:msg.id,data}));};
      try{
        if(msg.key==='key:channels:feed_profile'&&msg.data?.oid){
          const oid=String(msg.data.oid),nid=String(msg.data.nid||'');
          if(!/^[\w=-]{1,280}$/.test(oid)||nid.length>300)throw Error('视频号作品标识无效，请重新选择原作品');
          const found=await wait('finderGetCommentDetail');
          if(!found){send({errCode:1009,errMsg:'微信页面未取得原视频详情接口，请刷新视频号页面后继续当前任务。'});return;}
          const result=await found.fn.call(found.owner,{needObject:1,lastBuffer:'',scene:146,direction:2,identityScene:2,pullScene:6,objectid:oid.split('_')[0],objectNonceId:nid,encrypted_objectid:''});
          send(result);return;
        }
        if(msg.key==='key:channels:contact_list'){
          const keyword=String(msg.data?.keyword||'');
          const content=keyword.startsWith('__fengsha_content__:'),input=content?JSON.parse(keyword.slice(20)):null;
          if(content&&input.probe===true){send({errCode:0,data:{fengshaAdapterVersion:3}});return;}
          const query=content?input.query:keyword;
          if(typeof query!=='string'||!query.trim()||query.length>100)throw new Error('搜索关键词无效');
          const found=await wait('finderSearch');
          if(!found){send({errCode:1009,errMsg:'微信页面已连接，但采集组件未能取得搜索接口。自动识别未成功，需要更新页面适配；无需反复登录或开关视频号。',fengshaDiagnostics:{search:false,moduleStates:[...modules.values()]}});return;}
          const marker=msg.data.next_marker?decodeURIComponent(msg.data.next_marker):'';
          const cursor=content&&marker.startsWith('fengsha-page:')?JSON.parse(marker.slice(13)):null;
          if(cursor&&(!Number.isSafeInteger(cursor.offset)||cursor.offset<0||typeof cursor.lastBuff!=='string'||typeof cursor.requestId!=='string'))throw new Error('搜索分页信息无效，请重新搜索');
          const requestId=cursor?.requestId||(typeof input?.requestId==='string'?input.requestId:String(Date.now()));
          const result=await found.fn.call(found.owner,{query,scene:content?19:13,lastBuffer:cursor?.lastBuff??marker,lastBuff:cursor?.lastBuff??marker,...(cursor?{offset:cursor.offset}:{}),requestId});
          const data=result?.data,more=data?.objectContinueFlag??data?.continueFlag??data?.hasMore;
          const next=content&&(more===1||more===true)&&Number.isSafeInteger(data?.offset)&&data.offset>=0? 'fengsha-page:'+JSON.stringify({offset:data.offset,lastBuff:data.lastBuff||data.lastBuffer||'',requestId}):null;
          send({...result,data:{...data,...(content?{fengshaVersion:1,fengshaNextMarker:next}:{})}});return;
        }
        await old.call(this,msg,socket);
      }catch(error){send({errCode:1011,errMsg:String(error?.message||'微信页面接口调用失败').slice(0,240)});}
    };return true;
  };
  if(!attach()){let count=0;const timer=setInterval(()=>{if(attach()||++count>=40)clearInterval(timer);},250);}
})();
