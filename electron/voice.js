import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {command} from './engine.js';
export const VOICE_ORIGIN='https://openspeech.bytedance.com';
export const voiceDefaults={source:'original',execution:'confirm',authMode:'api-key',appId:'',speaker:'zh_female_vv_uranus_bigtts',speechRate:0,timeout:180};
const speakerOK=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,150}$/.test(v);
export function voiceOptions(raw={}){
  const c={...voiceDefaults,...raw};if(!['original','doubao'].includes(c.source)||!['automatic','confirm'].includes(c.execution)||!['api-key','access-token'].includes(c.authMode))throw Error('声音来源或执行方式无效');
  if(!speakerOK(c.speaker)||!Number.isInteger(Number(c.speechRate))||Number(c.speechRate)<-50||Number(c.speechRate)>100)throw Error('请输入有效音色 ID 和语速');
  return {source:c.source,execution:c.execution,authMode:c.authMode,appId:String(c.appId||'').trim().slice(0,100),speaker:c.speaker,speechRate:Number(c.speechRate),timeout:Math.min(600,Math.max(30,Number(c.timeout)||180))};
}
export function voiceReview(body,c,version=''){
  const audioHash=createHash('sha256').update(JSON.stringify([body,c.source,c.speaker,c.speechRate,version])).digest('hex');
  return {source:c.source,execution:c.execution,speaker:c.speaker,speechRate:c.speechRate,body,audioHash,hash:createHash('sha256').update(audioHash+':'+c.execution).digest('hex')};
}
export async function voiceStream(response){
  const buffers=[],decoder=new TextDecoder();let pending='',size=0,count=0,complete=false;
  const consume=text=>{text=text.trim().replace(/^data:\s*/,'');if(!text||text.startsWith(':')||text.startsWith('event:'))return;if(text==='[DONE]'){complete=true;return;}let r;try{r=JSON.parse(text);}catch{throw Error('豆包语音响应不完整，未保存配音');}
    if(![0,20000000].includes(r.code))throw Error(`豆包语音未完成合成（错误码 ${Number.isInteger(r.code)?r.code:'未知'}），请检查密钥、音色权限和资源类型`);
    count++;if(r.code===20000000||r.usage&&typeof r.usage==='object')complete=true;
    if(r.data){if(typeof r.data!=='string'||! /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(r.data))throw Error('豆包返回的音频编码无效');const b=Buffer.from(r.data,'base64');size+=b.length;if(size>64*1024*1024)throw Error('配音超过 64MB，请缩短正文');buffers.push(b);}
    return r;
  };
  // V3 accepts either one complete JSON response or JSON/SSE frames.
  const type=response.headers.get('content-type')||'';if(type.includes('application/json')){let raw='';for await(const chunk of response.body){raw+=decoder.decode(chunk,{stream:true});if(raw.length>90*1024*1024)throw Error('语音响应过大');}raw+=decoder.decode();try{const r=JSON.parse(raw);consume(raw);if(r.code===0&&r.data)complete=true;}catch(e){if(e instanceof SyntaxError){for(const line of raw.split(/\r?\n/))consume(line);}else throw e;}}
  else{for await(const chunk of response.body){pending+=decoder.decode(chunk,{stream:true});if(pending.length>90*1024*1024)throw Error('语音响应过大');let at;while((at=pending.indexOf('\n'))!==-1){consume(pending.slice(0,at));pending=pending.slice(at+1);}}pending+=decoder.decode();if(pending.trim())consume(pending);}
  if(!complete||!size)throw Error('豆包未返回完整音频，原声音和原文件保留');return Buffer.concat(buffers);
}
export class VoiceService{
  constructor({store,directory,vault,bin,fetcher=fetch,changed=()=>{}}){Object.assign(this,{store,directory,vault,bin,fetcher,changed});fs.mkdirSync(directory,{recursive:true});this.active=null;}
  credentials(){try{const c=JSON.parse(this.vault.decryptString(fs.readFileSync(path.join(this.directory,'doubao.encrypted'))));return c.origin===VOICE_ORIGIN?c:{};}catch{return {};}}
  config(){const c=voiceOptions(this.store.get('voice-config','doubao')||{}),keys=this.credentials();return {...c,hasAPIKey:!!keys.apiKey,hasAccessToken:!!keys.accessToken,profiles:this.store.list('voice-profile')};}
  save(raw){if(this.active)throw Error('声音任务正在执行，请等待完成');const c=voiceOptions(raw),old=this.credentials();const secrets={origin:VOICE_ORIGIN,apiKey:raw.clearAPIKey?'':String(raw.apiKey||'').trim()||old.apiKey||'',accessToken:raw.clearAccessToken?'':String(raw.accessToken||'').trim()||old.accessToken||''};
    if(/[\r\n]/.test(secrets.apiKey+secrets.accessToken))throw Error('声音密钥不能包含换行');if(raw.apiKey||raw.accessToken||raw.clearAPIKey||raw.clearAccessToken){if(!this.vault.isEncryptionAvailable())throw Error('Windows 加密暂不可用，声音密钥未保存');const file=path.join(this.directory,'doubao.encrypted');fs.writeFileSync(file+'.tmp',this.vault.encryptString(JSON.stringify(secrets)),{mode:0o600});fs.renameSync(file+'.tmp',file);}
    this.store.put('voice-config','doubao',c);this.store.flush();this.changed();return this.config();
  }
  review(body){const c=this.config(),profile=c.profiles.find(p=>p.id===c.speaker);return voiceReview(body,c,profile?.version||profile?.trainedAt||'');}
  async run(fn,signal){if(this.active)throw Error('豆包声音任务正在运行，请等待完成');const own=this.active=new AbortController(),combined=signal?AbortSignal.any([signal,own.signal]):own.signal;this.changed();try{return await(this.pending=fn(combined));}finally{this.active=null;this.pending=null;this.changed();}}
  cancel(){this.active?.abort();}async close(){this.cancel();await this.pending?.catch(()=>{});}
  headers(c,clone=false){const keys=this.credentials(),headers={'Content-Type':'application/json'};
    if(clone){if(!c.appId||!keys.accessToken)throw Error('声音克隆请先设置 App ID、Access Token 及控制台分配的 S_ 音色 ID');return {...headers,Authorization:'Bearer;'+keys.accessToken,'Resource-Id':'seed-icl-2.0'};}
    if(c.authMode==='api-key'){if(!keys.apiKey)throw Error('请先在声音设置保存豆包 API Key');headers['X-Api-Key']=keys.apiKey;}
    else{if(!c.appId||!keys.accessToken)throw Error('请先在声音设置保存豆包 App ID 和 Access Token');Object.assign(headers,{'X-Api-App-Id':c.appId,'X-Api-Access-Key':keys.accessToken});}
    headers['X-Api-Resource-Id']=c.speaker.startsWith('S_')?'seed-icl-2.0':'seed-tts-2.0';headers['X-Api-Request-Id']=randomUUID();return headers;
  }
  async request(route,c,body,signal,clone=false){let r;try{r=await this.fetcher(VOICE_ORIGIN+route,{method:'POST',headers:this.headers(c,clone),body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(c.timeout*1000)])});}catch(e){if(signal.aborted)throw Error('声音任务已停止');if(/请先|声音克隆/.test(e.message))throw e;throw Error('豆包声音连接失败或超时，请检查网络和服务配置');}if(!r.ok)throw Error(`豆包声音请求失败（HTTP ${r.status}），请检查密钥、音色和开通权限`);return r;}
  synthesize(text,file,signal){return this.run(async s=>{if(typeof text!=='string'||!text.trim()||text.length>30000)throw Error('配音正文须为 1–30000 字；不会截断正文合成');const c=this.config(),profile=c.profiles.find(p=>p.id===c.speaker);if(profile&&![2,4].includes(profile.status))throw Error('所选复刻音色尚未训练完成，请先查询训练状态');
    const response=await this.request('/api/v3/tts/unidirectional',c,{req_params:{text,speaker:c.speaker,...(c.speaker.startsWith('S_')?{model:'seed-tts-2.0-standard'}:{}),audio_params:{format:'mp3',sample_rate:24000,speech_rate:c.speechRate}}},s);
    const bytes=await voiceStream(response);s.throwIfAborted();const tmp=file+'.tmp.mp3';try{fs.writeFileSync(tmp,bytes);const probe=JSON.parse(await command(path.join(this.bin,'ffmpeg','ffprobe.exe'),['-v','error','-show_format','-show_streams','-of','json',tmp],{signal:s}));const duration=Number(probe.format?.duration);if(!probe.streams?.some(v=>v.codec_type==='audio')||!Number.isFinite(duration)||duration<=0||duration>7200)throw Error('豆包返回的音频校验失败，原声音保留');s.throwIfAborted();fs.renameSync(tmp,file);return {file,duration,speaker:c.speaker};}finally{try{fs.unlinkSync(tmp);}catch{}}
  },signal);}
  async json(route,c,body,s){const r=await this.request(route,c,body,s,true);const text=await r.text();if(text.length>1024*1024)throw Error('声音复刻响应过大');let data;try{data=JSON.parse(text);}catch{throw Error('声音复刻响应格式无效');}if(data.BaseResp?.StatusCode!==0)throw Error(`声音复刻未完成（错误码 ${Number.isInteger(data.BaseResp?.StatusCode)?data.BaseResp.StatusCode:'未知'}），请检查音色槽位与权限`);return data;}
  clone(file,speaker,text){return this.run(async s=>{const c=this.config();this.headers(c,true);if(!/^S_[A-Za-z0-9_-]{1,120}$/.test(speaker)||typeof text!=='string'||!text.trim()||text.length>3000)throw Error('请输入控制台分配的 S_ 音色 ID 和样本音频实际朗读的文字');
    const tmp=path.join(this.directory,randomUUID()+'.wav');try{await command(path.join(this.bin,'ffmpeg','ffmpeg.exe'),['-hide_banner','-loglevel','error','-i',file,'-t','60','-vn','-ac','1','-ar','24000','-c:a','pcm_s16le',tmp],{signal:s,timeout:60000});const probe=JSON.parse(await command(path.join(this.bin,'ffmpeg','ffprobe.exe'),['-v','error','-show_format','-of','json',tmp],{signal:s}));if(Number(probe.format?.duration)<5||fs.statSync(tmp).size>10*1024*1024)throw Error('请提供至少 5 秒的清晰人声音频，最多取开头 60 秒');
    const bytes=fs.readFileSync(tmp),hash=createHash('sha256').update(bytes).update(text).digest('hex'),old=this.store.get('voice-profile',speaker);if(old?.sampleHash===hash&&[1,2,4,'uncertain'].includes(old.status))throw Error('这一份样本已提交，请查询现有训练状态，不会重复训练');
    const pending={id:speaker,resource:'seed-icl-2.0',status:'uncertain',sampleHash:hash,submittedAt:Date.now()};this.store.put('voice-profile',speaker,pending);this.store.flush();
    const data=await this.json('/api/v1/mega_tts/audio/upload',c,{speaker_id:speaker,appid:c.appId,audios:[{audio_bytes:bytes.toString('base64'),text:text.trim(),audio_format:'wav'}],model_type:4,source:2},s);const next={...pending,status:[2,4].includes(data.status)?data.status:1,version:String(data.version||''),trainedAt:Date.now()};this.store.put('voice-profile',speaker,next);this.store.flush();this.changed();return next;}finally{try{fs.unlinkSync(tmp);}catch{}}
  });}
  status(speaker){return this.run(async s=>{if(!/^S_[A-Za-z0-9_-]{1,120}$/.test(speaker))throw Error('请输入有效的复刻音色 ID');const c=this.config(),data=await this.json('/api/v1/mega_tts/status',c,{appid:c.appId,speaker_id:speaker},s);if(![0,1,2,3,4].includes(data.status))throw Error('豆包未返回明确训练状态');const next={...(this.store.get('voice-profile',speaker)||{}),id:speaker,status:data.status,version:String(data.version||''),updatedAt:Date.now()};this.store.put('voice-profile',speaker,next);this.store.flush();this.changed();return next;});}
}
