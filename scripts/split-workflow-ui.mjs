import fs from 'node:fs';
import assert from 'node:assert/strict';
function edit(file,replacements){let text=fs.readFileSync(file,'utf8');for(const [before,after] of replacements){assert.ok(text.includes(before),`${file}: missing anchor`);text=text.replace(before,after);}fs.writeFileSync(file,text);}
edit('src/AISettings.jsx',[
  ['${draft.hasKey ? \'green\' : \'\'}','${speech && draft.mode === \'local\' || draft.hasKey ? \'green\' : \'\'}'],
  ["{draft.hasKey ? '密钥已加密保存' : '密钥未配置'}","{speech && draft.mode === 'local' ? '本地转录 · 无需密钥' : draft.hasKey ? '密钥已加密保存' : '密钥未配置'}"]
]);
let ai=fs.readFileSync('src/AISettings.jsx','utf8');ai=ai.slice(0,ai.indexOf('export default function AISettings'))+`export default function AISettings({state,perform,safe,notify,back}) {
  const busyTasks=state.transcriptions.some(t=>['preparing','subtitles','transcribing','summarizing','translating'].includes(t.status));
  return <><header className="page-heading"><div><h1>AI 模型设置</h1><p>只用于语音转录、摘要与翻译；博主下载无需配置 AI。</p></div><button className="button" onClick={back}>去转录与摘要</button></header><Provider kind="text" initial={state.ai.text} {...{perform,notify,busyTasks}}/><Provider kind="speech" initial={state.ai.speech} {...{perform,notify,busyTasks}}/><details className="panel collector-advanced"><summary>本地语音运行环境</summary><p className="ai-environment">{state.speechEnvironment.runtime?'✓ 语音运行环境已安装':'语音运行环境未安装'} · 已安装模型：{state.speechEnvironment.models.join('、') || '无'}</p><p className="hint">base 更快；small 更适合中文。原文可审阅，原视频保留。</p></details><div className="ai-actions"><button className="text-button" onClick={()=>safe('openGuide','cpa')}>打开 CPA 平台</button><button className="text-button" onClick={()=>safe('openGuide','audio')}>语音接口说明</button></div></>;
}
`;fs.writeFileSync('src/AISettings.jsx',ai);
edit('src/main.jsx',[
  ["import AISettings from './AISettings.jsx';","import AISettings from './AISettings.jsx';\nimport CollectorSettings from './CollectorSettings.jsx';"],
  ["[['new', Plus, '新建下载'],","[['new', Plus, '链接下载'], ['creator', Users, '博主批量下载'],"],
  ["(id === 'new' && ['selection', 'creator'].includes(page))","(id === 'new' && page === 'selection')"],
  ["? 'active' : ''} onClick={() => setPage(id)}","? 'active' : ''} onClick={() => setPage(id)}"],
  [">AI 与采集设置</button>",">AI 模型设置</button><button className={page === 'collector-settings' ? 'active' : ''} onClick={() => setPage('collector-settings')}><Link size={20}/>视频号连接</button>"],
  ["settings={() => setPage('ai-settings')} reidentify=","settings={() => setPage('collector-settings')} source={text} setSource={setText} identify={identifyCreator} reidentify="],
  ["{page === 'accounts' &&","{page === 'collector-settings' && <CollectorSettings {...{state,perform,notify}} back={() => setPage('creator')}/>}\n      {page === 'accounts' &&"],
  ["<strong>AI 模型与视频号采集</strong><p>配置 CPA、选择摘要与语音模型，连接作者作品采集服务</p>","<strong>下载偏好</strong><p>保存目录、画质和下载数量在本页设置；微信连接和 AI 模型分别配置。</p>"],
  ["<Sparkles size={17}/>AI 与采集设置","<Sparkles size={17}/>AI 模型设置"],
  ['<Heading title="新建下载"','<Heading title="链接下载"']
]);
edit('src/CreatorPage.jsx',[
  ['reidentify, done, error })','reidentify, done, error, source, setSource, identify })'],
  ['<div className="breadcrumb"><button onClick={back}>新建下载</button><span>›</span>博主作品</div>','<div className="workflow-strip"><span><b>1</b>识别博主</span><span><b>2</b>读取作品</span><span><b>3</b>勾选下载</span></div>'],
  ['<h1>博主作品</h1>','<h1>博主批量下载</h1>'],
  ['{error && <div',`<section className="panel creator-source"><label>博主主页或原视频链接<input aria-label="博主链接" value={source || ''} onChange={e=>setSource(e.target.value)} placeholder="粘贴博主主页或任意一条作品链接" disabled={busy || identifying}/></label><button className="button primary" disabled={!source?.trim() || busy || identifying} onClick={()=>identify()}><Search size={17}/>{creator?'识别新博主':'识别博主'}</button></section>
    {state.collectorConnection && ['preparing','waiting','restoring'].includes(state.collectorConnection.phase) && <div className="creator-notice"><LoaderCircle className="spin" size={17}/>{state.collectorConnection.label}</div>}
    {error && <div`],
  ['<p>部分平台会打开官方页面，请在页面中完成登录或验证。</p>','<p>{state.collectorConnection?.phase === \'waiting\' ? \'请在微信中重新进入视频号页面；连接成功后自动继续。\' : \'正在确认原链接作者；首次使用视频号会提示确认临时连接。\'}</p>'],
  [" : <Users size={30}/>}</div>"," : null}<Users size={30}/></div>"],
  ['<span>使用的登录账号</span><strong>{login ? login.name : \'未选择账号 · 尝试公开内容\'}</strong><small>{login?.status || \'需要时请先登录\'}</small><button className="text-button" onClick={() => accounts(creator.platform)}>管理平台账号</button>',`{creator.platform === '视频号' ? <><span>作品读取与下载</span><strong>使用微信视频号连接</strong><small>无需元宝账号 · 按任务自动连接</small><button className="text-button" onClick={settings}>视频号连接设置</button></> : <><span>使用的登录账号</span><strong>{login ? login.name : '未选择账号 · 尝试公开内容'}</strong><small>{login?.status || '需要时请先登录'}</small><button className="text-button" onClick={() => accounts(creator.platform)}>管理平台账号</button></>}`],
  ['连接视频号采集服务','准备微信连接'],
  ['{creator.reason && <div',"{(!creator.supported || creator.needsCollector) && creator.reason && <div"],
  ['<h2><CalendarDays size={20}/>作品读取范围</h2>','<h2><CalendarDays size={20}/>读取作品</h2>'],
  ["duplicate(item) ? '已下载' : '下载时解析'","duplicate(item) ? '已下载' : item.acquisition === 'wechat-collector' ? '微信下载' : '下载时解析'"],
  ['<h3>先粘贴博主主页或一个视频链接</h3><p>选择“识别博主”，再确认需要读取的作品范围。</p><button className="button" onClick={back}>返回输入链接</button>','<h3>读取博主的发布作品</h3><p>在上方粘贴主页或原视频链接，识别后选择读取范围并勾选下载。视频号首次使用可先准备微信连接。</p><button className="button" onClick={settings}>视频号连接</button>']
]);
