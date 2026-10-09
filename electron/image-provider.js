export const CPA_IMAGE_BASE='https://cpa.fengsha.online/v1';
export const CPA_IMAGE_MODEL='gpt-image-2.5-sunburst';
export const isImage25=model=>typeof model==='string'&&/^gpt[-_]?image[-_]?2[._]5(?:[-_][\w.-]+)?$/i.test(model.split('/').at(-1));
export function imageConfiguration(stored={}){return {...stored,name:'CPA 图片服务',baseUrl:CPA_IMAGE_BASE,model:isImage25(stored.model)?stored.model:CPA_IMAGE_MODEL,timeout:Number(stored.timeout)||300};}
