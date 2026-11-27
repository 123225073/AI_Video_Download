import {createHash} from 'node:crypto';
export function contactHash(platform,userId,accountId,text){return createHash('sha256').update([platform,userId,accountId,text].join('\n')).digest('hex');}
export function contactText(template,comment,source,rendered=false){
  if(typeof template!=='string'||!template.trim()||template.length>2000)throw new Error('请输入 1–2000 字的联系文案');
  const fields={'{昵称}':comment.name,'{评论}':String(comment.text||'').slice(0,300),'{作品}':source.title};
  const text=rendered?template:template.replace(/\{(?:昵称|评论|作品)\}/g,placeholder=>fields[placeholder]??'');
  if(text.length>2000)throw new Error('替换昵称或评论后文案超过2000字，请缩短模板');return text;
}
