import {createHash} from 'node:crypto';

export const promptHash=(style,prompt)=>createHash('sha256').update(JSON.stringify([style,prompt])).digest('hex');
export function prepareArticlePrompts(article,style) {
  const result=structuredClone(article);
  result.imageStyle=style || article.imageStyle || article.visualEvidence?.styleDescription || '现代编辑插画；米白底、深蓝文字、少量暖橙强调；简洁、清晰、克制';
  result.promptRevision=(article.promptRevision||0)+1;
  result.pages=result.pages.map((p,i)=>({...p,generationPrompt:p.generationPrompt||[
    `创作一组连续图文中的第 ${i+1} / ${result.pages.length} 张成品配图，竖幅 2:3，1024×1536。`,
    `主题：${article.title}。本页主题：${p.title}。`,
    `画面设计：${p.imagePrompt}。用具体主体、动作和环境表现本页观点；主视觉清晰，不使用空泛的装饰拼贴。`,
    `版式：${i===0?'封面，以醒目的核心主体和简短标题建立主题':i===result.pages.length-1?'收尾页，以清晰的行动场景或结论意象收束':'内容页，以单一重点场景或有阅读顺序的示意构图说明观点'}；顶部预留标题区，中部为主视觉，下部留白，四周安全边距约 8%。`,
    '系列一致性：严格沿用整组统一画风、配色、字体层级、光照与材质；同一人物的外观、服装和同一物件的形态前后一致。主体完整，层次分明，背景不过度抢眼。',
    `文字：仅可出现准确的页标题「${p.title}」和本页材料中的少量必要关键词；标题清晰可读，不放整段正文、不伪造小字。`,
    `内容依据（用于理解，不要全文写入画面）：${p.text}`,
    '约束：不得新增事实、数字、统计图表或夸张结论；示意画面不冒充真实拍摄证据。不要平台水印、Logo、乱码、无关文字、低清晰度或畸形肢体。'
  ].join('\n')}));
  return result;
}

