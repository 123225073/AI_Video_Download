// Public page indicators only. Never return cookie, password or storage values.
export function externalLoginState(platform){
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const has=selector=>[...document.querySelectorAll(selector)].some(visible);
  if(platform==='YouTube'){
    if(!['www.youtube.com','youtube.com'].includes(location.hostname))return {authenticated:false,message:'请在 Chrome 官方页面完成 Google 登录后返回 YouTube，再检测。'};
    if(has('button#avatar-btn,ytd-topbar-menu-button-renderer #avatar-btn'))return {authenticated:true};
    return {authenticated:false,message:'Chrome 已接入，但当前 YouTube 页面尚未确认登录；公开内容仍以实际读取结果为准。'};
  }
  if(platform==='小红书'){
    if(has('.login-modal,[class*="login-container"]'))return {authenticated:false,message:'请先在 Chrome 的小红书官方页完成登录或验证。'};
    if([...document.querySelectorAll('.side-bar a[href*="/user/profile/"],nav a[href*="/user/profile/"],aside a[href*="/user/profile/"]')].some(e=>visible(e)&&/^我$/.test(e.innerText.trim())))return {authenticated:true};
  }
  if(platform==='抖音'){
    if(has('[data-e2e="login-dialog"],.login-modal')||/验证码中间页|安全验证/.test(document.title))return {authenticated:false,message:'请在 Chrome 中完成抖音官方登录或验证。'};
    if(has('[data-e2e="top-avatar"],[data-e2e="user-avatar"]'))return {authenticated:true};
  }
  if(platform==='B站'&&has('.header-avatar-wrap.header-avatar-wrap--container,.header-avatar-wrap.header-avatar-wrap--login'))return {authenticated:true};
  return {authenticated:null,message:'已接入同一 Chrome 会话，登录状态尚待平台实际操作确认。'};
}
