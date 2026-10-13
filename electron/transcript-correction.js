import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const OpenCC = createRequire(import.meta.url)('opencc-js');
const simplifyChinese = OpenCC.Converter({ from: 't', to: 'cn' });
export const simplifiedText = text => simplifyChinese(String(text || ''));
export function simplifiedRecognition(result) {
  if (!/^(zh|chinese)/i.test(result.language || '')) return result;
  return { ...result, text: simplifiedText(result.text), segments: (result.segments || []).map(s => ({ ...s, text: simplifiedText(s.text) })) };
}
const digits = { 零: '0', 〇: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
const units = { 十: 10n, 百: 100n, 千: 1000n, 万: 10000n, 亿: 100000000n };
function chineseInteger(value) {
  if ([...value].every(c => c in digits)) return [...value].map(c => digits[c]).join('');
  if (/^[零〇]|[一二两三四五六七八九]{2}/.test(value)) return null;
  // Colloquial "一千二" is ambiguous (1200/1002); never infer its value.
  if (/[百千万亿][一二两三四五六七八九]$/.test(value)) return null;
  let total = 0n, section = 0n, digit = 0n, previousUnit = Infinity, bigUnit = 1n;
  for (const c of value) {
    if (c in digits) { digit = BigInt(digits[c]); continue; }
    const unit = units[c]; if (!unit) return null;
    if (unit < 10000n) {
      if (Number(unit) >= previousUnit) return null;
      section += (digit || 1n) * unit; previousUnit = Number(unit);
    } else {
      total = unit > bigUnit ? (total + section + digit) * unit : total + (section + digit) * unit;
      section = 0n; previousUnit = Infinity; bigUnit = unit;
    }
    digit = 0n;
  }
  return String(total + section + digit);
}
function numericValue(raw) {
  const value = raw.replaceAll(',', '');
  const arabic = /^(\d+(?:\.\d+)?)([万亿]?)$/.exec(value);
  const chinese = /^([零〇一二两三四五六七八九十百千万亿]+)点([零〇一二三四五六七八九]+)([万亿]?)$/.exec(value);
  let number, multiplier = '';
  if (arabic) { number = arabic[1]; multiplier = arabic[2]; }
  else if (chinese) { const integer = chineseInteger(chinese[1]); if (integer === null) return `raw:${raw}`;
    number = integer + '.' + [...chinese[2]].map(c => digits[c]).join(''); multiplier = chinese[3]; }
  else { number = chineseInteger(value); if (number === null) return `raw:${raw}`; }
  // Preserve leading zero identifiers. Compare explicit decimal values without floating point.
  if (/^0\d/.test(number)) return number;
  const [integer, fraction = ''] = number.split('.');
  const shift = multiplier === '万' ? 4 : multiplier === '亿' ? 8 : 0;
  const all = integer + fraction + '0'.repeat(Math.max(0, shift - fraction.length));
  const position = integer.length + shift;
  const whole = all.slice(0, position).replace(/^0+(?=\d)/, '') || '0';
  const decimal = all.slice(position).replace(/0+$/, '');
  return whole + (decimal ? '.' + decimal : '');
}
function normalizedNumbers(value) {
  const tokens = [];
  const pattern = /([+\-负正]?)(百分之\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?[万亿]?|\d+(?:\.\d+)?[万亿]?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二三四五六七八九]+[万亿]?)?)(\s*%)?/g;
  const text = String(value || '').normalize('NFKC').replace(pattern, (raw, sign, percent, number, suffix, offset, full) => {
    // A single Chinese numeral inside a word (统一/二创/万物) is not a quantity.
    if (number.length === 1 && !/\d/.test(number) && !percent && !suffix &&
      !/^[\s]*(?:公里|公斤|毫升|分钟|小时|个|只|张|辆|杯|瓶|碗|块|颗|头|匹|支|根|双|对|组|份|袋|箱|册|幅|次|步|项|秒|分|时|天|周|年|月|日|字|元|人|台|本|条|种|米|吨|斤|克|升|倍|成|岁|章|节|级|位|点|度|件|套)/.test(full.slice(offset + raw.length)) &&
      !/^\s*(?:[^\p{Script=Han}]|$)/u.test(full.slice(offset + raw.length)) &&
      !/(?:第|共|为|是|等于|[:：])\s*$/.test(full.slice(0, offset)) && offset + raw.length !== full.length) return raw;
    const token = (sign === '-' || sign === '负' ? '-' : '') + numericValue(number) + (percent || suffix ? '%' : '');
    tokens.push(token); return `<${token}>`;
  });
  return { tokens, text };
}
export const correctionNumbers = value => normalizedNumbers(value).tokens;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const correctionSourceHash = record => createHash('sha256').update(String(record.transcript || '')).digest('hex');
export const correctionCandidateHash = (record, text, segments = []) => hash({ id: record.id,
  sourceHash: correctionSourceHash(record), sourceSegments: record.segments || [], generation: record.correctionRunId || null, text, segments });
export function correctionVerification(source, text, acceptedText) {
  const sourceNumbers = correctionNumbers(source), candidateNumbers = correctionNumbers(text);
  const numericChanges = [];
  for (let i = 0; i < Math.max(sourceNumbers.length, candidateNumbers.length); i++) {
    if (sourceNumbers[i] !== candidateNumbers[i]) numericChanges.push({ index: i, source: sourceNumbers[i] ?? null, candidate: candidateNumbers[i] ?? null });
  }
  const acceptedNumbers = typeof acceptedText === 'string' ? correctionNumbers(acceptedText) : null;
  const acceptedNumericChanges = [];
  if (acceptedNumbers) for (let i = 0; i < Math.max(acceptedNumbers.length, candidateNumbers.length); i++) {
    if (acceptedNumbers[i] !== candidateNumbers[i]) acceptedNumericChanges.push({ index: i, accepted: acceptedNumbers[i] ?? null, candidate: candidateNumbers[i] ?? null });
  }
  const sourceNumbersChanged = numericChanges.length > 0, acceptedNumbersChanged = acceptedNumericChanges.length > 0;
  const numbersChanged = sourceNumbersChanged || acceptedNumbersChanged;
  return { structuralValidation: 'passed', numbersChanged, sourceNumbersChanged, acceptedNumbersChanged,
    sourceNumbers, candidateNumbers, numericChanges, acceptedNumbers, acceptedNumericChanges,
    numericStatus: numbersChanged ? 'requires-review' : 'unchanged', factualVerified: false, acceptance: numbersChanged ? 'pending' : 'automatic' };
}

// Decode only public text fields, even when a JSON string is still streaming.
export function correctionStreamText(value, batch) {
  const clean = String(value || '').replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');
  if (!batch) return clean;
  try {
    const result = JSON.parse(clean.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    if (Array.isArray(result.segments)) return result.segments.filter(s => typeof s.text === 'string').map(s => s.text).join('\n');
  } catch { /* An unfinished JSON response still has readable text fields. */ }
  const texts = [];
  const pattern = /(?<!\\)"text"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gs;
  for (const match of clean.matchAll(pattern)) {
    const part = match[1].replace(/\\(?:u[0-9a-f]{0,3})?$/i, '');
    try { texts.push(JSON.parse('"' + part + '"')); } catch { break; }
  }
  return texts.join('\n');
}

export function correctionPreview(record, patch) {
  return { transcriptionId: record.id, text: '', chunkText: '', chunk: 0, totalChunks: 0,
    phase: record.correctPairs ? 'timed' : 'plain', active: true, complete: false,
    contentComplete: false, chunkComplete: false, validation: 'pending', requiresReview: true,
    verification: { structuralValidation: 'pending', factualVerified: false, acceptance: 'pending' },
    ...(record.correctionPreview || {}), ...patch, updatedAt: Date.now() };
}
// Conservative length/sequence checks reject summaries and rewrites; they cannot prove factual correctness.
export function validateCorrection(source, reply) {
  const text = simplifiedText(reply).trim();
  const compact = value => simplifiedText(value).replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
  const sourceNumbers = normalizedNumbers(source), replyNumbers = normalizedNumbers(text);
  // ASR values are not ground truth. Mask quantities only for structural checks;
  // numeric differences are retained and reported separately for user review.
  const original = compact(sourceNumbers.text.replace(/<[^>]+>/g, '<number>'));
  const corrected = compact(replyNumbers.text.replace(/<[^>]+>/g, '<number>'));
  if (!corrected || text.includes('\u0000') || corrected.length < original.length * 0.8 || corrected.length > original.length * 1.25 + 12 || /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->|^\s*\[\d{2}:\d{2}(?::\d{2})?\]|^\s*```|^\s*#{1,6}\s/m.test(text)) throw new Error('模型校正文案不完整或格式不符，原文保留；请重试');
  // Match short anchors in order to detect unrelated content, omitted middle sections or duplicated context.
  let cursor = 0, matches = 0, total = 0;
  for (let i = 0; i + 3 <= original.length; i += 3) { total++; const anchor = original.slice(i, i + 3), found = corrected.indexOf(anchor, cursor); if (found >= 0) { matches++; cursor = found + 3; } }
  if (total >= 8 && matches / total < 0.55) throw new Error('模型改动过大，未保存为完整校正文案；请对照原文后重试');
  return text;
}
