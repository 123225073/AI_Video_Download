import React, { useState } from 'react';
import ImageSettings from './ImageSettings.jsx';
import VoiceSettings from './VoiceSettings.jsx';
import { Settings2, KeyRound, RefreshCw, CheckCircle2, LoaderCircle, Link, Mic, ExternalLink } from 'lucide-react';

function Provider({ kind, initial, perform, notify, busyTasks }) {
  const [draft, setDraft] = useState({ ...initial, apiKey: '' }), [models, setModels] = useState([]), [working, setWorking] = useState(false), [message, setMessage] = useState('');
  const speech = kind === 'speech', update = (key, value) => setDraft(d => ({ ...d, [key]: value }));
  async function execute(action) {
    setWorking(true); setMessage('');
    try {
      const saved = await perform('aiSave', kind, draft); setDraft({ ...saved, apiKey: '' });
      if (action === 'models') { const list = await perform('aiModels', kind); setModels(list); setMessage(`读取到 ${list.length} 个模型，请选择或手动填写。模型目录不代表支持语音转录。`); }
      else if (action === 'test') { const result = await perform('aiTest'); setMessage(`文本连接成功 · ${result.model} · ${result.reply}`); }
      else { setMessage('配置已保存，后续任务使用此配置'); notify('AI 配置已加密保存'); }
    } catch (e) { setMessage(e.message); } finally { setWorking(false); }
  }
  return <section className="panel ai-provider"><div className="section-title"><h2>{speech ? <Mic size={21}/> : <Settings2 size={21}/>} {speech ? '语音转录 · 把声音变成文字' : '文本模型 · 文案矫正与翻译'}</h2><span className={`badge ${speech && draft.mode === 'local' || draft.hasKey ? 'green' : ''}`}>{speech && draft.mode === 'local' ? '本地转录 · 无需密钥' : draft.hasKey ? '密钥已加密保存' : '密钥未配置'}</span></div>
    {speech && <div className="choice-cards"><button className={draft.mode === 'local' ? 'selected' : ''} onClick={() => update('mode', 'local')}><strong>本地转录（推荐）</strong><span>在电脑上识别语音，无需语音 API 密钥</span></button><button className={draft.mode === 'remote' ? 'selected' : ''} onClick={() => update('mode', 'remote')}><strong>在线语音服务</strong><span>发送音频到你配置的转录服务</span></button></div>}
    {speech && draft.mode === 'local' ? <div className="ai-form-grid"><label>本地语音模型<select aria-label="本地语音模型" value={draft.localModel} onChange={e => update('localModel', e.target.value)}><option value="base">base · 速度优先</option><option value="small">small · 中文质量优先</option></select></label><label>原音频语言<select value={draft.language} onChange={e => update('language', e.target.value)}><option value="auto">自动识别</option><option value="zh">简体中文</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option></select></label></div> : <>
      <div className="ai-form-grid"><label>服务名称<input aria-label={`${speech ? '语音' : '文本'}服务名称`} value={draft.name} onChange={e => update('name', e.target.value)} placeholder="CPA / 其他兼容服务"/></label><label>服务地址<input aria-label={`${speech ? '语音' : '文本'}服务地址`} value={draft.baseUrl} onChange={e => update('baseUrl', e.target.value)} placeholder="https://你的服务地址/v1"/></label><label className="ai-wide">API 密钥<input aria-label={`${speech ? '语音' : '文本'} API 密钥`} type="password" autoComplete="off" value={draft.apiKey} onChange={e => update('apiKey', e.target.value)} placeholder={draft.hasKey ? '已保存；留空保留，输入新密钥替换' : '仅在此输入，不会写入日志或网页存储'}/><small>更换服务域名后需重新填写密钥。密钥只发送给你选择的服务。</small></label><label className="ai-wide">{speech ? '语音转录模型' : 'AI 矫正与翻译模型'}<div className="model-input"><input list={`model-list-${kind}`} aria-label={`${speech ? '语音转录' : 'AI 矫正与翻译'}模型`} value={draft.model} onChange={e => update('model', e.target.value)} placeholder="读取模型后选择，也可直接填写完整模型名称"/><datalist id={`model-list-${kind}`}>{models.map(m => <option value={m} key={m}/>)}</datalist><button className="button" disabled={working || busyTasks} onClick={() => execute('models')}><RefreshCw size={16}/>保存并读取模型</button></div></label></div>
      {speech ? <p className="hint">服务必须支持 audio/transcriptions。CPA 的文本模型列表不能证明它支持语音；接口不支持时，请切换本地转录。</p> : <details className="ai-advanced"><summary>高级配置 · 接口类型与长内容处理</summary><div className="ai-form-grid"><label>接口类型<select value={draft.protocol} onChange={e => update('protocol', e.target.value)}><option value="chat">Chat Completions（通用兼容）</option><option value="responses">Responses</option></select></label><label>输出长度参数<select value={draft.tokenParameter} onChange={e => update("tokenParameter", e.target.value)}><option value="max_tokens">max_tokens（通用）</option><option value="max_completion_tokens">max_completion_tokens（推理模型）</option></select></label><label>请求超时（秒）<input type="number" min="30" max="600" value={draft.timeout} onChange={e => update('timeout', e.target.value)}/></label><label>每段原文长度（字符）<input type="number" min="2000" max="30000" value={draft.chunkChars} onChange={e => update('chunkChars', e.target.value)}/></label><label>单次输出长度（Token）<input type="number" min="500" max="12000" value={draft.outputTokens} onChange={e => update('outputTokens', e.target.value)}/></label></div><p className="hint">长视频会自动分段处理。输出被截断时会提示重试，不完整文案不会保存为成功结果。</p></details>}
    </>}
    <div className="ai-actions"><button className="button primary" disabled={working || busyTasks} onClick={() => execute('save')}>{working ? <LoaderCircle size={17} className="spin"/> : <KeyRound size={17}/>}保存{speech ? '语音' : '文本'}配置</button>{!speech && <button className="button" disabled={working || busyTasks} onClick={() => execute('test')}><CheckCircle2 size={17}/>保存并测试文本连接</button>}</div>{message && <p className="ai-feedback" role="status">{message}</p>}{busyTasks && <p className="hint">任务正在运行，请完成或停止后更改模型配置。</p>}
  </section>;
}
export default function AISettings({state,perform,safe,notify,back,embedded=false}) {
  const [group, setGroup] = useState('all');
  const busyTasks=!!state.contentProgress||state.transcriptions.some(t=>['preparing','subtitles','transcribing','correcting','summarizing','translating'].includes(t.status));
  const show = key => group === 'all' || group === key;
  return <>{!embedded && <header className="page-heading"><div><h1>AI 模型设置</h1><p>用于语音转录、文案矫正与多语言翻译；博主下载无需配置 AI。</p></div><button className="button" onClick={back}>去转录与翻译</button></header>}
  <div className="ai-subnav" role="tablist" aria-label="AI 服务分组">
    {[['all','全部服务'],['text','文本矫正与翻译'],['speech','语音转录'],['image','图片二创'],['voice','豆包配音']].map(([id,label]) => (
      <button key={id} role="tab" aria-selected={group === id} className={group === id ? 'selected' : ''} onClick={() => setGroup(id)}>{label}</button>
    ))}
  </div>
  <div hidden={!show('text')}><Provider kind="text" initial={state.ai.text} {...{perform,notify,busyTasks}}/></div>
  <div hidden={!show('speech')}><Provider kind="speech" initial={state.ai.speech} {...{perform,notify,busyTasks}}/></div>
  <div hidden={!show('image')}><ImageSettings {...{state,perform}}/></div>
  <div hidden={!show('voice')}><VoiceSettings {...{state,perform}}/></div>
  <details className="panel collector-advanced"><summary>本地语音运行环境</summary><p className="ai-environment">{state.speechEnvironment.runtime?'✓ 语音运行环境已安装':'语音运行环境未安装'} · 已安装模型：{state.speechEnvironment.models.join('、') || '无'}</p><p className="hint">base 更快；small 更适合中文。原文可审阅，原视频保留。</p></details><div className="ai-actions"><button className="text-button" onClick={()=>safe('openGuide','cpa')}>打开 CPA 平台</button><button className="text-button" onClick={()=>safe('openGuide','audio')}>语音接口说明</button></div></>;
}
