import { createRequire } from 'node:module';
const OpenCC = createRequire(import.meta.url)('opencc-js');
const simplifyChinese = OpenCC.Converter({ from: 't', to: 'cn' });
export const simplifiedText = text => simplifyChinese(String(text || ''));
export function simplifiedRecognition(result) {
  if (!/^(zh|chinese)/i.test(result.language || '')) return result;
  return { ...result, text: simplifiedText(result.text), segments: (result.segments || []).map(s => ({ ...s, text: simplifiedText(s.text) })) };
}
// Conservative length/sequence checks reject summaries and rewrites; they cannot prove factual correctness.
export function validateCorrection(source, reply) {
  const text = simplifiedText(reply).trim();
  const compact = value => simplifiedText(value).replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
  const original = compact(source), corrected = compact(text);
  if (!corrected || corrected.length < original.length * 0.8 || corrected.length > original.length * 1.25 + 12 || /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->|^\s*\[\d{2}:\d{2}(?::\d{2})?\]|^\s*```|^\s*#{1,6}\s/m.test(text)) throw new Error('模型校正文案不完整或格式不符，原文保留；请重试');
  const numbers = value => value.match(/\d+(?:[.,]\d+)*/g) || [];
  if (JSON.stringify(numbers(source)) !== JSON.stringify(numbers(text))) throw new Error('模型改动了原文数字，未保存校正文案；请核对原文后重试');
  // Match short anchors in order to detect unrelated content, omitted middle sections or duplicated context.
  let cursor = 0, matches = 0, total = 0;
  for (let i = 0; i + 3 <= original.length; i += 3) { total++; const anchor = original.slice(i, i + 3), found = corrected.indexOf(anchor, cursor); if (found >= 0) { matches++; cursor = found + 3; } }
  if (total >= 8 && matches / total < 0.55) throw new Error('模型改动过大，未保存为完整校正文案；请对照原文后重试');
  return text;
}
