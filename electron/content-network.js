export function contentLoadCode(error){
  const raw=String(error?.code||'')+' '+String(error?.message||'');
  const code=raw.match(/\b(?:ERR_[A-Z_]+|BROWSER_[A-Z_]+|OFFICIAL_[A-Z_]+)\b/)?.[0];if(code)return code;
  if(/Chrome connection closed|Chrome.*连接.*(?:关闭|中断)|Target closed|Session closed|Session with given id not found/i.test(raw))return 'BROWSER_CONNECTION_CLOSED';
  if(/Execution context was destroyed|Cannot find (?:default execution context|context with specified id)/i.test(raw))return 'BROWSER_CONTEXT_CHANGED';
  if(/Chrome 官方页面加载超时|Chrome command timed out/i.test(raw))return 'ERR_TIMED_OUT';
  if(/网页已离开所选平台/.test(raw))return 'BROWSER_PAGE_OUTSIDE';
  return 'BROWSER_LOAD_FAILED';
}
export function contentAction(reason,message){
  const kind=reason==='device-limit'||reason==='login'?'login':reason==='verification'?'verification':reason==='network'?'network':'page';
  return {kind,message,retryable:kind==='network',label:kind==='login'?'打开官方登录':kind==='verification'?'打开验证页面':kind==='network'?'重新连接':'打开官方窗口'};
}
const sourceMessage=error=>String(error?.sourceMessage||error?.message||'未知页面错误').replace(/https?:\/\/[^\s)）]+/gi,'[官方页面地址]').replace(/(?:token|cookie|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi,'[已隐藏]').slice(0,220);
export function contentLoadMessage(error){
  const code=contentLoadCode(error);
  const hint=/ERR_PROXY|ERR_TUNNEL/.test(code)?'本机代理未能连接，请确认代理程序和端口正在运行，无需关闭系统代理'
    :/ERR_CERT/.test(code)?'官方页面证书校验未通过，请检查系统时间或本机 HTTPS 代理证书'
    :/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/.test(code)?'官方页面连接超时，请稍后继续读取'
    :/ERR_NAME_NOT_RESOLVED/.test(code)?'官方域名解析失败，请检查网络与 DNS'
    :/ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET/.test(code)?'与官网的连接被中途断开，当前网络可能限制该平台；请确认网络允许访问后重新连接'
    :/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(code)?'官方页面跳转被中断，请重新打开官方窗口完成登录或验证'
    :code==='BROWSER_CONNECTION_CLOSED'?'专用浏览器连接中断，请重新连接；原有登录保留'
    :code==='BROWSER_CONTEXT_CHANGED'?'官方页面正在切换，尚未读取到本次作品，请继续读取'
    :code==='BROWSER_PAGE_OUTSIDE'?'当前窗口不是本次官方页面，请重新打开本次搜索'
    :code==='BROWSER_LOAD_FAILED'?`官方作品页面准备失败：${sourceMessage(error)}`
    :'官方作品页面连接失败，请检查网络后继续读取';
  return `${hint}（${code}）${error?.recoveryAttempts>0?'；已自动重连一次':''}；已取得的作品和读取位置保留。`;
}
export function contentLoadError(error){
  if(error?.action)return error;
  const code=contentLoadCode(error),message=contentLoadMessage(error);
  return Object.assign(new Error(message,{cause:error}),{code,sourceMessage:sourceMessage(error),needsAction:true,action:contentAction(/^ERR_|BROWSER_(?:CONNECTION_CLOSED|CONTEXT_CHANGED)/.test(code)?'network':'page',message),recoveryAttempts:error?.recoveryAttempts||0});
}
