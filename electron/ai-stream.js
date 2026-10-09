// Stream only public output text. Reasoning/tool deltas never enter the editor.
export async function readTextStream(response,protocol,signal,onText){
  const decoder=new TextDecoder();let buffer='',text='',bytes=0,complete=false;
  const frame=value=>{const lines=value.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart());if(!lines.length)return;const raw=lines.join('\n');if(raw==='[DONE]')return;
    let data;try{data=JSON.parse(raw);}catch{throw Error('模型流式响应格式无效，原稿保留');}
    if(data.error||['error','response.failed','response.incomplete'].includes(data.type))throw Error('模型生成未完成，原稿保留，可手工重试');
    let delta='';if(protocol==='responses'){
      if(data.type==='response.output_text.delta'&&data.output_index===0&&data.content_index===0)delta=data.delta||'';
      if(data.type==='response.completed'){if(data.response?.status!=='completed')throw Error('模型响应未完整结束，原稿保留');complete=true;}
    }else{const choice=data.choices?.find(c=>c.index===0);if(choice?.delta?.refusal)throw Error('模型未生成二创正文，原稿保留');delta=choice?.delta?.content||'';if(choice?.finish_reason){if(choice.finish_reason!=='stop')throw Error('模型输出未完整结束，请调整输出长度后重试；原稿保留');complete=true;}}
    if(typeof delta==='string'&&delta){text+=delta;if(text.length>2000000)throw Error('模型响应过大');onText(text);}
  };
  try{for await(const chunk of response.body){signal?.throwIfAborted();bytes+=chunk.byteLength;if(bytes>8*1024*1024)throw Error('模型响应过大');buffer+=decoder.decode(chunk,{stream:true});let m;while((m=buffer.match(/\r?\n\r?\n/))){frame(buffer.slice(0,m.index));buffer=buffer.slice(m.index+m[0].length);}}
    buffer+=decoder.decode();if(buffer.trim())frame(buffer);signal?.throwIfAborted();if(!complete||!text.trim())throw Error('模型连接结束但正文未完整返回，原稿保留');return text;
  }catch(e){if(signal?.aborted)throw Error('已停止处理');throw e;}
}
export function draftTextPreview(value){
  const preview={};const text=value.replace(/<think>[\s\S]*?(?:<\/think>|$)/g,'');
  for(const name of ['title','body','tags']){const match=new RegExp('(?<!\\\\)"'+name+'"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)(?:"|$)','s').exec(text);if(!match)continue;let v=match[1].replace(/\\(?:u[0-9a-f]{0,3})?$/i,'');try{preview[name]=JSON.parse('"'+v+'"');}catch{}}
  return preview;
}
