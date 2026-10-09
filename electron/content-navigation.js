export function contentNavigation(value,initialURL,platform){
  try{const u=new URL(value),initial=new URL(initialURL),official=u.hostname===initial.hostname||platform==='小红书'&&u.hostname==='xiaohongshu.com';
    if(!official||u.username||u.password||u.port)return {allowed:false};
    if(u.protocol==='https:')return {allowed:true};
    // Never fetch the downgrade URL. Restart only this official navigation over TLS.
    if(u.protocol==='http:'){u.protocol='https:';return {allowed:false,upgrade:u.href};}
  }catch{}
  return {allowed:false};
}
