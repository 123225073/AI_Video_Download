import fs from 'node:fs';
import path from 'node:path';

export const providerDefaults = { name: 'CPA', baseUrl: 'https://cpa.fengsha.online/v1', model: '', protocol: 'chat', tokenParameter: 'max_tokens', timeout: 120, outputTokens: 3000, chunkChars: 10000 };
export const speechDefaults = { name: '语音服务', baseUrl: '', model: '', mode: 'local', localModel: 'small', language: 'zh', timeout: 180 };
export const imageDefaults = { name:'图片二创', baseUrl:'https://api.openai.com/v1', model:'gpt-image-2.5-sunburst', timeout:300 };
export function apiBase(value) {
  let u; try { u = new URL(String(value).trim()); } catch { throw new Error('请填写有效的模型服务地址'); }
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('服务地址请使用 HTTPS；本机服务可使用 HTTP，不要把密钥放进地址');
  return u.href.replace(/\/+$/, '');
}
function bounded(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }

// Credentials never enter Store records, renderer snapshots, task data or error text.
export class AIService {
  constructor(store, directory, vault, changed = () => {}, request = fetch) { this.store = store; this.directory = directory; this.vault = vault; this.changed = changed; this.fetch = request; }
  secretFile(kind) { return path.join(this.directory, `ai-${kind}.encrypted`); }
  secret(kind, base) {
    try { const value = JSON.parse(this.vault.decryptString(fs.readFileSync(this.secretFile(kind)))); return value.origin === new URL(base).origin ? value.key : ''; } catch { return ''; }
  }
  config(kind = 'text') {
    const c = { ...(kind === 'speech' ? speechDefaults : kind === 'image' ? imageDefaults : providerDefaults), ...this.store.get('ai-config', kind) };
    return { ...c, hasKey: Boolean(c.baseUrl && this.secret(kind, c.baseUrl)) };
  }
  all() { return { text: this.config('text'), speech: this.config('speech'), image:this.config('image') }; }
  save(kind, raw) {
    if (!['text', 'speech','image'].includes(kind)) throw new Error('请选择文本、语音或图片服务');
    const old = this.config(kind), defaults = kind === 'speech' ? speechDefaults : kind === 'image' ? imageDefaults : providerDefaults;
    const baseUrl = raw.baseUrl?.trim() ? apiBase(raw.baseUrl) : kind === 'speech' ? '' : apiBase(defaults.baseUrl);
    const c = { name: String(raw.name || defaults.name).slice(0, 40), baseUrl, model: String(raw.model || '').trim().slice(0, 150), timeout: bounded(raw.timeout, defaults.timeout, 30, 600) };
    if (kind === 'speech') Object.assign(c, { mode: raw.mode === 'remote' ? 'remote' : 'local', localModel: ['tiny', 'base', 'small'].includes(raw.localModel) ? raw.localModel : speechDefaults.localModel, language: ['auto', 'zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'].includes(raw.language) ? raw.language : speechDefaults.language });
    else Object.assign(c, { protocol: raw.protocol === 'responses' ? 'responses' : 'chat', tokenParameter: raw.tokenParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens', outputTokens: bounded(raw.outputTokens, 3000, 500, 12000), chunkChars: bounded(raw.chunkChars, 10000, 2000, 30000) });
    const key = raw.clearKey ? '' : String(raw.apiKey || '').trim() || (baseUrl ? this.secret(kind, baseUrl) : '');
    if (raw.apiKey && /[\r\n]/.test(raw.apiKey)) throw new Error('密钥不能包含换行');
    if (key || raw.clearKey || (old.baseUrl && baseUrl && new URL(old.baseUrl).origin !== new URL(baseUrl).origin)) {
      if (!this.vault.isEncryptionAvailable()) throw new Error('Windows 加密暂不可用，密钥未保存，请稍后重试');
      fs.mkdirSync(this.directory, { recursive: true });
      const file = this.secretFile(kind);
      fs.writeFileSync(`${file}.tmp`, this.vault.encryptString(JSON.stringify({ origin: baseUrl ? new URL(baseUrl).origin : '', key })), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file);
    }
    this.store.put('ai-config', kind, c); this.store.flush(); this.changed(); return this.config(kind);
  }
  async request(kind, endpoint, body, signal) {
    const c = this.config(kind);
    if (!c.baseUrl) throw new Error('请先在 AI 设置填写服务地址');
    const key = this.secret(kind, c.baseUrl);
    if (!key) throw new Error('请先在 AI 设置保存此服务的 API 密钥');
    const controller = AbortSignal.timeout(c.timeout * 1000), combined = signal ? AbortSignal.any([signal, controller]) : controller;
    let response;
    try { response = await this.fetch(`${apiBase(c.baseUrl)}/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), redirect: 'error', signal: combined }); }
    catch { if (signal?.aborted) throw new Error('已停止处理'); throw new Error(controller.aborted ? '模型服务超时，请检查网络或调高超时后重试' : '无法连接模型服务，请检查地址、网络与证书'); }
    const errors = { 401: '模型密钥无效，请重新配置', 403: '当前密钥没有访问权限', 404: '此服务未提供所选接口，请检查服务地址或切换接口类型', 413: '音频或请求超过服务大小限制', 429: '模型服务限流或额度不足，请稍后重试', 400: '模型或请求参数不被此服务支持，请检查模型与接口类型' };
    if (!response.ok) { const e = new Error(errors[response.status] || `模型服务暂不可用（HTTP ${response.status}），请稍后重试`); e.status = response.status; throw e; }
    const text = await response.text(); if (text.length > 8 * 1024 * 1024) throw new Error('模型响应过大，请缩小处理范围');
    try { return JSON.parse(text); } catch { throw new Error('模型服务返回了非 JSON 内容，请检查服务地址'); }
  }
  async models(kind = 'text') {
    const data = await this.request(kind, 'models');
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null;
    if (!list) throw new Error('服务未返回模型列表，可手动填写模型名称');
    return [...new Set(list.map(m => typeof m === 'string' ? m : m.id).filter(x => typeof x === 'string' && x.length < 180))].sort();
  }
  async chat(system, content, signal) {
    const c = this.config(); if (!c.model) throw new Error('请先在 AI 设置读取并选择文本模型，或手动填写模型名称');
    const data = c.protocol === 'responses'
      ? await this.request('text', 'responses', { model: c.model, instructions: system, input: content, max_output_tokens: c.outputTokens, store: false }, signal)
      : await this.request('text', 'chat/completions', { model: c.model, messages: [{ role: 'system', content: system }, { role: 'user', content }], [c.tokenParameter]: c.outputTokens, stream: false }, signal);
    const text = c.protocol === 'responses' ? data.output_text || data.output?.flatMap(o => o.content || []).filter(o => o.type === 'output_text').map(o => o.text).join('\n') : data.choices?.[0]?.message?.content;
    if (data.choices?.[0]?.finish_reason === 'length' || data.status === 'incomplete') throw new Error('模型输出达到长度限制，结果未保存；请增加输出长度或减小分段长度后重试');
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回有效文字，请检查模型和接口类型');
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  async test() { const reply = await this.chat('只回复：连接成功。', '请验证中文文本响应。'); return { ok: true, model: this.config().model, reply: reply.slice(0, 120) }; }
  async transcribe(file, signal, language = 'auto') {
    const c = this.config('speech'); if (!c.model) throw new Error('请填写语音转录模型名称；文本模型不能代替语音模型');
    if (fs.statSync(file).size > 24 * 1024 * 1024) throw new Error('本段音频超过 24 MB，请使用本地转录');
    const form = new FormData(); form.set('model', c.model); form.set('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'audio.wav'); form.set('response_format', 'verbose_json'); if (language !== 'auto') form.set('language', language);
    const data = await this.request('speech', 'audio/transcriptions', form, signal);
    if (typeof data.text !== 'string') throw new Error('语音接口未返回文稿，所选服务可能不支持转录');
    return { text: data.text.trim(), language: data.language || language, segments: Array.isArray(data.segments) ? data.segments.map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '') })) : [] };
  }
}
