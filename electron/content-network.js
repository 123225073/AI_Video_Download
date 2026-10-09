export function contentLoadMessage(error){
  const code=String(error?.code||error?.message||'').match(/ERR_[A-Z_]+/)?.[0]||'LOAD_FAILED';
  const hint=/ERR_PROXY|ERR_TUNNEL/.test(code)?'本机代理未能连接，请确认代理程序和端口正在运行，无需关闭系统代理'
    :/ERR_CERT/.test(code)?'官方页面证书校验未通过，请检查系统时间或本机 HTTPS 代理证书'
    :/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/.test(code)?'官方页面连接超时，请稍后继续读取'
    :/ERR_NAME_NOT_RESOLVED/.test(code)?'官方域名解析失败，请检查网络与 DNS'
    :/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(code)?'官方页面跳转被中断，请重新打开官方窗口完成登录或验证'
    :'官方作品页面连接失败，请检查网络后继续读取';
  return `${hint}（${code}）；已取得的作品和读取位置保留。`;
}
