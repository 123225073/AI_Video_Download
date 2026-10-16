// Run only inside the selected official page; reads rendered public status, not session data.
// A normal "登录" header button does not prove the content requires authentication.
export function douyinPageState(){
  if(!['www.douyin.com','douyin.com'].includes(location.hostname)||location.protocol!=='https:')return {kind:'outside',retryable:false};
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
  const text=e=>String(e?.innerText||'').replace(/\s+/g,' ').trim();
  if(/验证码中间页|安全验证/.test(document.title)||[...document.querySelectorAll('[class*="captcha"],iframe[src*="captcha"]')].some(visible))return {kind:'verification',retryable:false,message:'抖音官方页面要求安全验证，请在官方窗口完成后继续。'};
  const labels=[...document.querySelectorAll('div,p,h1,h2,h3,span,[role="alert"]')].filter(visible).map(text);
  if(labels.some(t=>/^(?:服务器出现问题|服务器开小差了|服务暂时不可用|网络开小差了)[。！!]?$/u.test(t)))return {kind:'service-error',retryable:true,message:'抖音官方页面暂时未能返回内容，正在重新连接当前作品。'};
  if([...document.querySelectorAll('[data-e2e="login-dialog"],.login-modal')].some(e=>visible(e)&&/登录|扫码/.test(text(e))))return {kind:'login',retryable:false,message:'抖音当前内容需要在官方窗口完成登录，已有资料保留。'};
  return {kind:'unconfirmed',retryable:false};
}
