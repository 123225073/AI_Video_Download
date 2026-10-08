// Runs through the upstream's supported inject.globalScript extension.
// Search the exported objects by capability; the upstream's exclusive API groups
// can miss a function when WeChat merges modules. Never change the official function.
(() => {
  if(window.__fengshaContentInstalled)return;window.__fengshaContentInstalled=true;
  const registry=new Map();
  const capture=variables=>{for(const methods of Object.values(variables||{})){if(!methods||!['object','function'].includes(typeof methods))continue;for(const name of ['finderSearch','finderUserPage'])if(typeof methods[name]==='function')registry.set(name,{owner:methods,fn:methods[name]});}};
  if(typeof WXU!=='undefined'){capture({a:WXU.API,b:WXU.API2,c:WXU.API3,d:WXU.API4});WXU.onAPILoaded(capture);}
  const wait=async name=>{for(let i=0;i<20;i++){const found=registry.get(name);if(found)return found;await new Promise(r=>setTimeout(r,250));}return null;};
  const attach=()=>{
    if(typeof ws_client$==='undefined'||!ws_client$.methods||ws_client$.methods.__fengshaWrapped)return false;
    const methods=ws_client$.methods,old=methods.__wx_handle_api_call;methods.__fengshaWrapped=true;
    methods.__wx_handle_api_call=async function(msg,socket){
      const send=data=>{if(socket.readyState===1)socket.send(JSON.stringify({id:msg.id,data}));};
      try{
        if(msg.key==='key:channels:contact_list'){
          const keyword=String(msg.data?.keyword||'');const found=await wait('finderSearch');
          if(!found){send({errCode:1009,errMsg:'微信页面的搜索接口尚未加载或已变更，当前连接不代表搜索可用；请重新进入视频号页面后重试。'});return;}
          const content=keyword.startsWith('__fengsha_content__:'),query=content?JSON.parse(keyword.slice(20)).query:keyword;
          if(typeof query!=='string'||!query.trim()||query.length>100)throw new Error('搜索关键词无效');
          const marker=msg.data.next_marker?decodeURIComponent(msg.data.next_marker):'';
          const result=await found.fn.call(found.owner,{query,scene:content?19:13,lastBuffer:marker,lastBuff:marker,requestId:String(Date.now())});
          send({...result,data:{...result?.data,...(content?{fengshaVersion:1}:{})}});return;
        }
        await old.call(this,msg,socket);
      }catch(error){send({errCode:1011,errMsg:String(error?.message||'微信页面接口调用失败').slice(0,240)});}
    };return true;
  };
  if(!attach()){let count=0;const timer=setInterval(()=>{if(attach()||++count>=40)clearInterval(timer);},250);}
})();
