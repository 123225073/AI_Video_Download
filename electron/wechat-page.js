// Fixed registered WeChat URI; no account token, private data or arbitrary URL.
export async function openWeChatChannels(openExternal,signal){
  signal?.throwIfAborted();
  try{await openExternal('weixin://dl/channels');}catch{throw new Error('未能自动打开微信视频号，请确认已安装并登录电脑微信。');}
  signal?.throwIfAborted();return {attempted:true};
}
