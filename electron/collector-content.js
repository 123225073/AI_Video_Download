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
        if(msg.key==='key:channels:feed_profile'){
          const input=msg.data||{};let oid=String(input.oid||''),nid=String(input.nid||''),eid=String(input.eid||'');
          if(input.url){
            const u=new URL(String(input.url));
            if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('视频号链接无效');
            if(u.hostname==='weixin.qq.com'&&/^\/sph\/[a-zA-Z0-9_-]{1,100}\/?$/.test(u.pathname)||u.hostname==='channels.weixin.qq.com'&&u.pathname==='/finder-preview/pages/sph'){
              // The pinned upstream getFeedInfo.js uses this same-origin JSON
              // endpoint. Native fetch removes its on-demand axios/__assets
              // dependency after the previous task restored its route.
              const shortUri=u.pathname.startsWith('/sph/')?u.pathname.split('/')[2]:u.searchParams.get('id');
              if(!/^[a-zA-Z0-9_-]{1,100}$/.test(shortUri||''))throw Error('视频号分享链接标识无效');
              const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
              let shared;
              try{
                const response=await fetch('https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseReq:{generalToken:''},shortUri}),signal:controller.signal});
                if(!response.ok)throw Error('HTTP');shared=await response.json();
              }catch{throw Error('微信分享链接解析未完成，请确认原视频可访问后重试；已有资料保留');}
              finally{clearTimeout(timer);}
              if(shared?.errCode||shared?.error)throw Error('微信未能解析此分享链接，请确认原视频仍可访问');
              const exportId=shared?.data?.sceneInfo?.dynamicExportId;
              if(typeof exportId!=='string'||!exportId.trim()||exportId.length>1000)throw Error('微信分享链接未返回有效作品标识');
              eid=exportId;oid='';nid='';
              if(!eid)throw Error('微信分享链接未返回作品标识');
            }else if(u.hostname==='channels.weixin.qq.com'&&u.pathname==='/web/pages/feed'){
              if(typeof WXU==='undefined'||!WXU.Base64?.decodeBase64ToUint64String)throw Error('视频号链接解析接口未就绪');
              oid=String(WXU.Base64.decodeBase64ToUint64String(u.searchParams.get('oid')||''));
              nid=String(WXU.Base64.decodeBase64ToUint64String(u.searchParams.get('nid')||''));
            }else throw Error('不支持的微信作品链接');
          }
          if((!oid&&!eid)||(oid&&!/^[\w=-]{1,280}$/.test(oid))||nid.length>300||eid.length>1000)throw Error('视频号作品标识无效，请重新选择原作品');
          const found=await wait('finderGetCommentDetail');
          if(!found){send({errCode:1009,errMsg:'微信页面已连接，但原视频详情接口未就绪。请稍后继续当前任务。'});return;}
          const result=await found.fn.call(found.owner,{needObject:1,lastBuffer:'',scene:eid?141:146,direction:2,identityScene:2,pullScene:6,objectid:eid?undefined:oid.split('_')[0],objectNonceId:eid?undefined:nid,encrypted_objectid:eid});
          send(result);return;
        }
        if(msg.key==='key:channels:feed_list'){
          const username=String(msg.data?.username||'');
          if(!username||username.length>300)throw Error('视频号作者标识无效');
          const found=await wait('finderUserPage');
          if(!found){send({errCode:1009,errMsg:'微信页面已连接，但作者作品列表接口未就绪。已读取清单保留。'});return;}
          const marker=String(msg.data?.next_marker||'');if(marker.length>20000)throw Error('视频号分页信息无效');
          const result=await found.fn.call(found.owner,{username,finderUsername:typeof __wx_username==='string'?__wx_username:'',lastBuffer:marker?decodeURIComponent(marker):'',needFansCount:0,objectId:'0'});
          send(result);return;
        }
        if(msg.key==='key:channels:contact_list'){
          const keyword=String(msg.data?.keyword||'');
          const content=keyword.startsWith('__fengsha_content__:'),input=content?JSON.parse(keyword.slice(20)):null;
          if(content&&input.probe===true){
            const currentHash=window.__fengshaContentHash||null;
            if(input.reload===true){
              if(!/^[a-f0-9]{12}$/.test(input.expectedHash||''))throw Error('适配版本标识无效');
              const reloading=input.expectedHash!==currentHash&&window.__fengshaReloadTarget!==input.expectedHash;
              send({errCode:0,data:{fengshaAdapterVersion:4,fengshaContentHash:currentHash,canRefreshAdapter:true,reloading}});
              if(reloading){window.__fengshaReloadTarget=input.expectedHash;setTimeout(()=>window.location.reload(),200);}
              return;
            }
            await Promise.all(['finderSearch','finderGetCommentDetail','finderUserPage'].map(wait));
            send({errCode:0,data:{fengshaAdapterVersion:4,fengshaContentHash:currentHash,canRefreshAdapter:true,capabilities:{search:registry.has('finderSearch'),detail:registry.has('finderGetCommentDetail'),creatorFeeds:registry.has('finderUserPage')}}});return;
          }
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
      }catch(error){send({errCode:1011,errMsg:String(error?.message||'微信页面接口调用失败，请稍后重试').slice(0,240)});}
    };return true;
  };
  if(!attach()){let count=0;const timer=setInterval(()=>{if(attach()||++count>=40)clearInterval(timer);},250);}
})();
