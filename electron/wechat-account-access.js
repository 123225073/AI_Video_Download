// Keep the existing one-minute local pause; a server Retry-After may extend it.
export const WECHAT_ACCOUNT_PAUSE_MS=60*1000;
export function wechatRateLimitError(restriction={}){
 const details={code:'WECHAT_RATE_LIMIT',platformCode:'200013',retryAt:0,...restriction};
 return Object.assign(Error(`微信暂时限制了当前登录会话读取公众号文章列表（${details.platformCode}）。已停止自动重试，已有清单和读取位置保留。可稍后手动继续，或使用已有文章链接、公开合集采集；本机暂停结束不代表微信一定已解除限制。`),{needsAction:true,rateLimited:true,code:details.code,restriction:details});
}
export class WechatAccountAccess {
 constructor(store,{clock=Date.now,pauseMs=WECHAT_ACCOUNT_PAUSE_MS}={}){
  this.store=store;this.clock=clock;this.pauseMs=pauseMs;this.state=store?.get('article-meta','wechat-limit')||null;
  if(!Number.isFinite(this.state?.retryAt))this.state=null;
  const previous=store?.get('article-meta','discovery');
  if(!this.state&&previous&&/200013/.test(previous.message||''))this.block();
 }
 check(){if(this.state?.retryAt>this.clock())throw wechatRateLimitError(this.state);}
 block(platformCode='200013',retryAfterSeconds=0){
  const delay=Math.max(this.pauseMs,Math.min(Math.max(Number(retryAfterSeconds)||0,0)*1000,24*60*60*1000));
  this.state={code:'WECHAT_RATE_LIMIT',platformCode:String(platformCode),retryAt:this.clock()+delay};this.save();return wechatRateLimitError(this.state);
 }
 clear(){if(this.state){this.state=null;this.save();}}
 save(){this.store?.put('article-meta','wechat-limit',this.state||{retryAt:0});this.store?.flush?.();}
}
