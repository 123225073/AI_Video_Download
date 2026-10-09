import {createHash} from 'node:crypto';
export function contactHash(platform,userId,accountId,text){return createHash('sha256').update([platform,userId,accountId,text].join('\n')).digest('hex');}
export function contactText(template,comment,source,rendered=false){
  if(typeof template!=='string'||!template.trim()||template.length>2000)throw new Error('请输入 1–2000 字的联系文案');
  const text=rendered?template:template.replaceAll('{昵称}',comment.name).replaceAll('{评论}',comment.text.slice(0,300)).replaceAll('{作品}',source.title);
  if(text.length>2000)throw new Error('替换昵称或评论后文案超过2000字，请缩短模板');return text;
}
