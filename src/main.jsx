import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Wind, Plus, Download, ListTodo, Library, Users, Settings, CircleHelp, Search,
  FolderOpen, Check, ChevronRight, ArrowLeft, Clipboard, Trash2, X, Minus, Square,
  Play, Pause, RotateCw, AlertCircle, CheckCircle2, LoaderCircle, Clock, Grid2X2,
  List, SlidersHorizontal, ExternalLink, ShieldCheck, LogIn, Tag, FileVideo,
  Link, ArrowDown, FileText
} from 'lucide-react';
import './style.css';
import './workflow.css';
import './creator-workflow.css';
import CreatorPage from './CreatorPage.jsx';
import ContentPage from './ContentPage.jsx';
import ArticlePage from './ArticlePage.jsx';
import { enqueueInChunks, concurrencyLabel } from './batch.js';
import SettingsPage from './SettingsPage.jsx';
import TranscriptionPage from './TranscriptionPage.jsx';
import Thumb from './Thumbnail.jsx';
import MediaPreview from './MediaPreview.jsx';
import { useRecordRemoval } from './RecordRemoval.jsx';
import { ExternalBrowserStatus, AccountBrowserActions, useAccountBrowserLogin } from './ExternalBrowserLogin.jsx';
import { creatorLoginPrompt, bilibiliCreatorSource, CREATOR_LOGIN_REQUIRED } from '../electron/creator-login.js';
import { Sidebar, DownloadHeader } from './WorkspaceShell.jsx';
import './workspace.css';

const api = window.fengsha;
const PLATFORMS = ['视频号', '抖音', '小红书', 'B站', 'YouTube'];
const PLATFORM_CLASS = { '视频号': 'wechat', '抖音': 'douyin', '小红书': 'xhs', 'B站': 'bili', 'YouTube': 'youtube' };
const STATUS = {
  queued: '等待中',
  downloading: '下载中',
  processing: '合并 / 校验中',
  paused: '已暂停',
  completed: '已完成',
  failed: '需处理',
  cancelled: '已取消',
  'retry-wait': '等待重试',
};

const date = value => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');
const bytes = value => (
  !value ? '—'
    : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB`
      : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${Math.round(value / 1024)} KB`
);
const duration = value => (value ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '时长待获取');

async function call(name, ...args) {
  const r = await api[name](...args);
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
  return r.value;
}

function Button({ children, variant = '', className = '', ...props }) {
  return <button className={`button ${variant} ${className}`} {...props}>{children}</button>;
}

function Badge({ children, tone = '' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Platform({ name }) {
  return <span className={`platform ${PLATFORM_CLASS[name] || ''}`}>{name}</span>;
}

function Empty({ icon: Icon = FileVideo, title, text, action }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon size={24} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

function Modal({ title, children, close }) {
  return (
    <div className="modal-backdrop" onClick={close}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={close} aria-label="关闭"><X size={18} /></button>
        </div>
        {children}
      </section>
    </div>
  );
}

function App() {
  const [state, setState] = useState(null);
  const [page, setPage] = useState('new');
  const [group, setGroup] = useState(null);
  const [results, setResults] = useState([]);
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [toast, setToast] = useState(null);
  const [accountFilter, setAccountFilter] = useState('全部平台');
  const [creatorRecord, setCreatorRecord] = useState(null);
  const [identifying, setIdentifying] = useState(false);
  const [creatorError, setCreatorError] = useState(null);
  const [loginPrompt, setLoginPrompt] = useState(null);
  const [loginReturn, setLoginReturn] = useState(false);
  const [transcriptSeed, setTranscriptSeed] = useState(null);
  const [settingsSection, setSettingsSection] = useState('download');
  const [taskFilter, setTaskFilter] = useState('all');
  const [opened, setOpened] = useState({ search: false, articles: false });
  const [bootError, setBootError] = useState('');
  const [bootAttempt, retryBoot] = useState(0);
  const [externalVideoSeed, setExternalVideoSeed] = useState(null);

  const navigate = (id, filter) => {
    if (id === 'tasks') setTaskFilter(filter || 'all');
    setPage(id);
  };

  const contentVisible = page === 'search' || page === 'comments';
  useEffect(() => {
    if (contentVisible && !opened.search) setOpened(prev => ({ ...prev, search: true }));
    if (page === 'articles' && !opened.articles) setOpened(prev => ({ ...prev, articles: true }));
  }, [page, contentVisible, opened]);

  const goSettings = section => {
    setSettingsSection(section || 'download');
    setPage('settings');
  };
  const goVideo = source => {
    setExternalVideoSeed({ ...source, requestId: Date.now() });
    setPage('search');
  };
  const goTranscription = mediaId => {
    setTranscriptSeed({ mediaId });
    setPage('transcription');
  };

  useEffect(() => {
    call('creatorLast').then(setCreatorRecord).catch(() => {});
    return api.onCreatorChange(setCreatorRecord);
  }, []);

  const notify = (message, error = false) => {
    setToast({ message, error });
  };

  useEffect(() => {
    let current = true;
    let updated = false;
    setBootError('');
    const unsubscribe = api.onChange(value => {
      updated = true;
      setState(value);
    });
    call('snapshot')
      .then(value => { if (current && !updated) setState(value); })
      .catch(e => { if (current && !updated) setBootError(e.message); });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [bootAttempt]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const perform = async (name, ...args) => {
    try {
      return await call(name, ...args);
    } catch (e) {
      notify(e.message, true);
      throw e;
    }
  };
  const safe = (name, ...args) => perform(name, ...args).catch(() => {});

  const transcribeSource = async source => {
    try {
      const r = await perform('videoStart', { ...source, autoCorrect: false });
      setTranscriptSeed({ id: r.transcriptionId });
      setPage('transcription');
    } catch {}
  };

  async function parse(limit = 30, source = text) {
    setParsing(true);
    try {
      const r = await perform('parse', source, limit);
      setResults(r);
      if (limit > 30 && r[0]?.items.length) setGroup(r[0]);
    } catch {
      /* The error toast remains visible. */
    } finally {
      setParsing(false);
    }
  }

  const goAccounts = platform => {
    setLoginReturn(false);
    setAccountFilter(platform || '全部平台');
    setPage('accounts');
  };

  function ensureCreatorLogin(platform, message = null) {
    const issue = message
      ? { title: '请先登录 B站账号', message }
      : creatorLoginPrompt(platform, state?.accounts.find(a => a.platform === platform && a.active));
    if (!issue) return true;
    setLoginPrompt(issue);
    return false;
  }

  async function identifyCreator(source = text) {
    const input = typeof source === 'string' ? source : text;
    setPage('creator');
    if (bilibiliCreatorSource(input) && !ensureCreatorLogin('B站')) return;
    setIdentifying(true);
    setCreatorError(null);
    try {
      setCreatorRecord(await perform('creatorIdentify', input));
    } catch (e) {
      if (e.code === CREATOR_LOGIN_REQUIRED) ensureCreatorLogin('B站', e.message);
      else {
        setCreatorRecord(null);
        setCreatorError(e.message);
      }
    } finally {
      setIdentifying(false);
    }
  }

  if (!state) {
    return (
      <div className="boot">
        <Wind size={44} />
        <h2>风沙全平台视频下载器</h2>
        <p role="status">{bootError || '正在读取本地资料库…'}</p>
        {bootError && <Button onClick={() => retryBoot(n => n + 1)}>重新读取资料库</Button>}
      </div>
    );
  }

  const running = state.tasks.filter(t => ['downloading', 'processing'].includes(t.status));
  const speed = running.reduce((a, t) => a + (t.progress.speed || 0), 0);

  return (
    <div className={`application ${['transcription', 'archive'].includes(page) ? 'manuscript-mode' : page === 'settings' ? 'settings-mode' : ''}`}>
      <div className="titlebar">
        <div>
          <Wind size={15} />
          <span>风沙全平台视频下载器</span>
          <em className="titlebar-version">v{state.version}</em>
        </div>
        <div className="window-controls">
          <button aria-label="最小化" onClick={() => safe('windowAction', 'minimize')}><Minus size={15} /></button>
          <button aria-label="最大化" onClick={() => safe('windowAction', 'maximize')}><Square size={12} /></button>
          <button className="window-close" aria-label="关闭应用" onClick={() => safe('windowAction', 'close')}><X size={16} /></button>
        </div>
      </div>

      <div className="body">
        <Sidebar
          page={page}
          navigate={navigate}
          running={running.length}
          version={state.version}
          settings={() => goSettings(settingsSection)}
          help={() => safe('openHelp')}
        />
        <main className="main">
          <div hidden={page !== 'articles'}>
            {(opened.articles || page === 'articles') && <ArticlePage {...{ state, perform, safe }} />}
          </div>
          <div hidden={!contentVisible}>
            {(opened.search || contentVisible) && (
              <ContentPage
                commentsRoute={page === 'comments'}
                showSearch={() => setPage('search')}
                showComments={() => setPage('comments')}
                {...{ state, perform, safe, notify, externalVideoSeed }}
                accounts={goAccounts}
                settings={section => goSettings(section || 'collector')}
              />
            )}
          </div>
          {page === 'new' && (
            <NewDownload
              navigate={navigate}
              environmentSettings={() => goSettings('application')}
              {...{ state, text, setText, results, parsing, parse, safe, perform, notify, identifyCreator, identifying }}
              resumeCreator={creatorRecord ? () => setPage('creator') : null}
              open={g => { setGroup(g); setPage('selection'); }}
              settings={() => goSettings('download')}
              accounts={goAccounts}
            />
          )}
          {page === 'creator' && (
            <CreatorPage
              onVideo={goVideo}
              onTranscribe={transcribeSource}
              {...{ state, identifying, perform, safe, notify, ensureCreatorLogin }}
              onHistoryCleared={() => setCreatorError(null)}
              error={creatorError}
              record={creatorRecord}
              setRecord={setCreatorRecord}
              back={() => setPage('new')}
              accounts={goAccounts}
              settings={() => goSettings('collector')}
              source={text}
              setSource={setText}
              identify={identifyCreator}
              reidentify={() => identifyCreator(creatorRecord?.source || text)}
              done={() => setPage('tasks')}
            />
          )}
          {page === 'selection' && group && (
            <Selection
              onVideo={goVideo}
              onTranscribe={transcribeSource}
              {...{ state, group, perform, notify, parsing }}
              back={() => setPage('new')}
              more={() => parse(300, group.url)}
              done={() => setPage('tasks')}
            />
          )}
          {page === 'tasks' && (
            <Tasks
              initialFilter={taskFilter}
              {...{ state, safe, perform, notify }}
              accounts={goAccounts}
              newDownload={() => setPage('new')}
            />
          )}
          {page === 'library' && (
            <MediaLibrary
              onVideo={goVideo}
              {...{ state, safe, perform, notify }}
              newDownload={() => setPage('new')}
              transcribe={goTranscription}
            />
          )}
          {page === 'transcription' && (
            <TranscriptionPage key="transcription" {...{ state, safe, perform, notify }} seed={transcriptSeed} settings={() => goSettings('ai')} />
          )}
          {page === 'archive' && (
            <TranscriptionPage key="archive" {...{ state, safe, perform, notify }} archiveView settings={() => goSettings('ai')} />
          )}
          {page === 'accounts' && (
            <>
              {loginReturn && (
                <div className="creator-notice">
                  <CircleHelp size={18} />
                  <span>完成 B站登录并保存会话后，返回原来的博主页面继续操作。</span>
                  <Button onClick={() => { setLoginReturn(false); setPage('creator'); }}>返回博主读取</Button>
                </div>
              )}
              <Accounts {...{ state, safe, perform, notify }} filter={accountFilter} setFilter={setAccountFilter} />
            </>
          )}
          {page === 'settings' && (
            <SettingsPage
              {...{ state, safe, perform, notify }}
              section={settingsSection}
              select={setSettingsSection}
              transcribe={() => setPage('transcription')}
              creator={() => setPage('creator')}
              preferences={section => <Preferences {...{ state, safe, perform, notify, section }} accounts={goAccounts} />}
            />
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span><i className="status-dot" />本地资料库 · v{state.version}</span>
        <div>
          <span><ArrowDown size={13} />下载速度 {speed ? `${bytes(speed)}/s` : '—'}</span>
          <span><Download size={13} />{running.length} 个任务执行中</span>
        </div>
      </footer>

      <MediaPreview media={state.media} />

      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          {toast.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="关闭提示"><X size={15} /></button>
        </div>
      )}

      {loginPrompt && (
        <Modal title={loginPrompt.title} close={() => setLoginPrompt(null)}>
          <p>{loginPrompt.message}</p>
          <ol>
            <li>添加 B站账号，打开官方登录窗口。</li>
            <li>本人扫码或登录，完成页面要求的验证。</li>
            <li>回到账号管理点击“完成登录”，确认显示“下载使用中”。</li>
            <li>返回博主页面，再执行识别或读取。</li>
          </ol>
          <p className="hint">已填写的链接和已有清单保留；会话保存后仍以平台实际响应为准。</p>
          <div className="modal-actions">
            <Button onClick={() => setLoginPrompt(null)}>暂不执行</Button>
            <Button variant="primary" onClick={() => { setLoginPrompt(null); goAccounts('B站'); setLoginReturn(true); }}>去登录 B站</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Heading({ title, subtitle, action }) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

function NewDownload({
  navigate, environmentSettings, state, text, setText, results, parsing, parse,
  safe, perform, open, settings, accounts, identifyCreator, identifying, resumeCreator
}) {
  const [tab, setTab] = useState('single');
  const busy = parsing || identifying || Boolean(state.creatorProgress);

  async function pasteFromClipboard() {
    try {
      const value = await perform('clipboard');
      if (!value) return;
      if (tab === 'batch' && text.trim()) {
        setText(prev => `${prev.trimEnd()}\n${value}`);
      } else {
        setText(value);
      }
    } catch {}
  }

  function handleKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && text.trim() && !busy) {
      event.preventDefault();
      parse();
    }
  }

  return (
    <div className="download-workspace">
      <DownloadHeader state={state} environment={state.environment} navigate={navigate} settings={environmentSettings} />

      <section className="panel input-panel">
        <div className="input-panel-heading">
          <h2><Link size={17} />链接识别</h2>
          <div className="tabs">
            <button className={tab === 'single' ? 'selected' : ''} onClick={() => setTab('single')}>单条链接</button>
            <button className={tab === 'batch' ? 'selected' : ''} onClick={() => setTab('batch')}>批量链接</button>
          </div>
        </div>
        <textarea
          aria-label="视频链接"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tab === 'single' ? '粘贴视频、合集或播放列表的分享链接或文案…' : '每行粘贴一个链接，批量模式下点“粘贴链接”会自动换行追加…'}
          rows={tab === 'single' ? 4 : 6}
        />
        <div className="input-actions">
          <div>
            <Button onClick={pasteFromClipboard}><Clipboard size={15} />粘贴链接</Button>
            <Button variant="quiet" onClick={() => setText('')} disabled={!text}><Trash2 size={15} />清空</Button>
            <span className="input-shortcut-hint">一次最多 30 条 · Ctrl + Enter 识别</span>
          </div>
          <Button disabled={!text.trim() || busy} onClick={identifyCreator}><Users size={16} />识别博主</Button>
          <Button variant="primary" disabled={!text.trim() || busy} onClick={() => parse()}>
            {parsing ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}识别视频 / 合集
          </Button>
        </div>
        {parsing && (
          <div className="parse-status">
            <LoaderCircle className="spin" size={15} />
            {state.parseProgress
              ? `正在识别第 ${state.parseProgress.index} / ${state.parseProgress.total} 个链接 · ${state.parseProgress.platform}`
              : '正在联系源平台…'}
            <span>部分平台需要登录，识别不会自动下载</span>
          </div>
        )}
        <div className="defaults-inline-bar" aria-label="下载默认设置">
          <span className="defaults-inline-item">
            <FolderOpen size={14} />
            <button className="text-button path" onClick={() => safe('locateFile', null)} title={`打开目录：${state.settings.savePath}`}>
              {state.settings.savePath}
            </button>
          </span>
          <span className="defaults-inline-sep" aria-hidden="true" />
          <span className="defaults-inline-item">画质 <b>{state.settings.quality === 'best' ? '最高可用' : `${state.settings.quality}p 以内`}</b></span>
          <span className="defaults-inline-item">并发 <b>{concurrencyLabel(state.settings.concurrency)}</b></span>
          <span className="defaults-inline-item">归档 <b>{{ collection: '平台 / 作者 / 合集', author: '平台 / 作者', flat: '直接保存' }[state.settings.archive] || '默认'}</b></span>
          <button className="text-button defaults-inline-edit" onClick={settings}><Settings size={13} />修改设置</button>
        </div>
      </section>

      <section className="platform-strip" aria-label="接入平台与登录状态">
        <strong>接入平台</strong>
        {PLATFORMS.map(p => {
          const acc = state.accounts.find(a => a.platform === p && a.active);
          const ok = Boolean(acc && acc.status !== '需要重新登录' && (acc.lastSync || acc.lastVerified || acc.status === '最近解析成功'));
          const warn = Boolean(acc && acc.status === '需要重新登录');
          return (
            <button key={p} onClick={() => accounts(p)} title={acc ? `${p}：${acc.name}（${acc.status}）` : `点击配置 ${p} 登录账号`}>
              <i className={`platform-pill-dot ${ok ? 'ok' : warn ? 'warn' : ''}`} />
              <Platform name={p} />
              <span className="platform-pill-state">{warn ? '需重登' : ok ? acc.name : '未登录'}</span>
            </button>
          );
        })}
        <span>点击平台管理登录</span>
      </section>

      <div className="section-title results-head">
        <h2>本次识别 {results.length ? <small>({results.length})</small> : null}</h2>
        {resumeCreator && <Button onClick={resumeCreator}><Users size={15} />继续上次博主清单</Button>}
      </div>

      {results.length ? (
        <div className="results">
          {results.map((g, i) => (
            <section className="result-row" key={`${g.url}-${i}`}>
              <Thumb item={g.items[0] || {}} />
              <div className="result-description">
                <h3>{g.title || `${g.platform}分享链接`}</h3>
                <p>{g.error || (g.items.length > 1 ? `已获取 ${g.items.length} 条${g.complete ? ' · 清单读取完成' : ' · 清单可能尚未完整'}` : g.items[0]?.author || '')}</p>
                <span className="source-url" title={g.url}>{g.url}</span>
              </div>
              <Platform name={g.platform} />
              <Badge tone={g.error ? 'amber' : 'blue'}>
                {g.error ? (g.category === 'auth' ? '需要登录' : '解析失败') : g.items.length > 1 ? '集合 / 列表' : '单视频'}
              </Badge>
              {g.error ? (
                <Button onClick={() => (g.category === 'auth' ? accounts(g.platform) : safe('openSource', g.url))}>
                  {g.category === 'auth' ? '去登录' : '检查原链接'}<ChevronRight size={15} />
                </Button>
              ) : (
                <Button variant="primary" onClick={() => open(g)}>
                  {g.items.length > 1 ? '选择条目' : '查看内容'}<ChevronRight size={15} />
                </Button>
              )}
            </section>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty icon={Link} title="从一个视频链接开始" text="识别后会展示标题、平台和可选条目，由你确认后加入下载队列。" />
        </section>
      )}
      <p className="bottom-hint"><CircleHelp size={15} />合集首次读取最多 30 条，可在内容选择页继续读取。</p>
    </div>
  );
}

function Selection({ onVideo, onTranscribe, state, group, perform, notify, back, more, done, parsing }) {
  const duplicate = item => state.media.some(m => m.id === item.key && m.exists);
  const [selected, setSelected] = useState(() => new Set(group.items.filter(i => i.available && !duplicate(i)).map(i => i.key)));
  const [query, setQuery] = useState('');
  const [quality, setQuality] = useState(state.settings.quality);
  const [archive, setArchive] = useState(state.settings.archive);
  const [savePath, setSavePath] = useState(state.settings.savePath);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setQuery('');
    setSelected(new Set(group.items.filter(i => i.available && !duplicate(i)).map(i => i.key)));
  }, [group.url]);

  const visible = group.items.filter(i => i.title.toLowerCase().includes(query.toLowerCase()));
  function toggle(id) {
    setSelected(previous => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function onRowClick(event, item) {
    if (!item.available || event.target.closest('button, input, a, [data-media-preview-ready]')) return;
    toggle(item.key);
  }

  async function submit() {
    setConfirm(false);
    setBusy(true);
    try {
      const result = await enqueueInChunks(perform, group.items.filter(i => selected.has(i.key)), { quality, archive, savePath, force });
      notify(`已加入 ${result.added.length} 条，跳过 ${result.skipped.length} 条${result.error ? `；后续提交中断：${result.error}` : ''}`, Boolean(result.error));
      if (result.added.length && !result.error) done();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="breadcrumb">
        <button onClick={back}>新建下载</button>
        <ChevronRight size={14} />内容选择
      </div>
      <Heading
        title="内容选择"
        subtitle={`${group.platform} · 已获取 ${group.items.length} 条 · ${group.complete ? '当前清单读取完成' : '清单可能尚未完整'}`}
        action={<Button onClick={back}><ArrowLeft size={15} />返回链接输入</Button>}
      />
      <div className="selection-layout">
        <div>
          <section className="panel collection-banner">
            <Thumb item={group.items[0] || {}} />
            <div>
              <h2>{group.title}</h2>
              <p><Platform name={group.platform} /> {group.items[0]?.author}</p>
            </div>
            {!group.complete && (
              <Button disabled={parsing} onClick={more}>
                {parsing ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}读取更多（最多 300 条）
              </Button>
            )}
          </section>
          <div className="selection-toolbar">
            <Button onClick={() => setSelected(new Set(visible.filter(i => i.available).map(i => i.key)))}>全选当前结果</Button>
            <Button onClick={() => setSelected(new Set(visible.filter(i => i.available && !selected.has(i.key)).map(i => i.key)))}>反选</Button>
            <Button onClick={() => setSelected(new Set(visible.filter(i => i.available && !duplicate(i)).map(i => i.key)))}>仅选未下载</Button>
            <label className="search">
              <Search size={16} />
              <input placeholder="搜索标题" aria-label="筛选视频标题" value={query} onChange={e => setQuery(e.target.value)} />
            </label>
          </div>
          <section className="panel selection-table">
            <div className="selection-row table-head"><span /><span>序号</span><span>视频</span><span>时长</span><span>画质</span><span>状态</span></div>
            {visible.map((item, index) => (
              <div className="selection-row" key={item.key} onClick={e => onRowClick(e, item)}>
                <input
                  aria-label={`选择 ${item.title}`}
                  type="checkbox"
                  checked={selected.has(item.key)}
                  disabled={!item.available}
                  onChange={() => toggle(item.key)}
                />
                <span>{index + 1}</span>
                <div className="selection-video">
                  <Thumb item={item} />
                  <div>
                    <strong title={item.title}>{item.title}</strong>
                    <div className="source-creative-actions">
                      <Button disabled={!item.available || busy} onClick={() => onTranscribe({ item })}>语音识别</Button>
                      <Button disabled={!item.available || busy} onClick={() => onVideo({ item, title: item.title })}>对标二创</Button>
                    </div>
                  </div>
                </div>
                <span>{duration(item.duration)}</span>
                <span>{item.height ? `${item.height}p` : '下载时确认'}</span>
                <Badge tone={!item.available ? 'amber' : duplicate(item) ? 'green' : 'blue'}>
                  {!item.available ? '不可用' : duplicate(item) ? '已在媒体库' : '可加入队列'}
                </Badge>
              </div>
            ))}
            {!visible.length && <Empty title="没有匹配的条目" text="试试其他关键词。" />}
          </section>
        </div>

        <section className="panel download-options">
          <h2>下载选项</h2>
          <p className="chosen">已选择 <strong>{selected.size}</strong> 条</p>
          <label>
            画质
            <select value={quality} onChange={e => setQuality(e.target.value)}>
              <option value="best">最高可用</option>
              <option value="1080">1080p 以内</option>
              <option value="720">720p 以内</option>
              <option value="480">480p 以内</option>
            </select>
          </label>
          <label>
            保存位置
            <div className="folder-input">
              <input value={savePath} readOnly title={savePath} />
              <button aria-label="选择保存位置" onClick={async () => { try { const p = await perform('chooseFolder'); if (p) setSavePath(p); } catch {} }}>
                <FolderOpen size={16} />
              </button>
            </div>
          </label>
          <label>
            文件夹规则
            <select value={archive} onChange={e => setArchive(e.target.value)}>
              <option value="collection">平台 / 作者 / 合集</option>
              <option value="author">平台 / 作者</option>
              <option value="flat">直接保存到目录</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} />已有视频另存一份
          </label>
          <div className="soft-note">
            <CircleHelp size={16} />
            <span>{group.platform === '视频号' ? '视频号下载完整视频，画质由当前源链接决定。' : '画质与格式以源站实际提供为准，自动合并音视频。'}</span>
          </div>
        </section>
      </div>

      <div className="selection-footer">
        <strong>已选择 <em>{selected.size}</em> 条</strong>
        <div>
          <Button onClick={back}>返回</Button>
          <Button variant="primary" disabled={!selected.size || busy} onClick={() => (selected.size > 30 ? setConfirm(true) : submit())}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}加入下载队列 ({selected.size})
          </Button>
        </div>
      </div>

      {confirm && (
        <Modal title="确认批量下载" close={() => setConfirm(false)}>
          <p>你选择了 {selected.size} 条视频，采用{concurrencyLabel(state.settings.concurrency)}，根据实际资源依次下载。</p>
          <p className="hint">占用空间以实际媒体大小为准，文件保存在所选目录。</p>
          <div className="modal-actions">
            <Button onClick={() => setConfirm(false)}>返回检查</Button>
            <Button variant="primary" onClick={submit}>确认加入队列</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Tasks({ initialFilter, state, safe, perform, notify, accounts, newDownload }) {
  const removal = useRecordRemoval('task', state.tasks, perform, notify);
  const [filter, setFilter] = useState(initialFilter || 'all');
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('全部平台');
  const [detailId, setDetailId] = useState(null);

  useEffect(() => {
    setFilter(initialFilter || 'all');
  }, [initialFilter]);

  const match = (t, f) => (
    f === 'all'
      || (f === 'running' ? ['downloading', 'processing'].includes(t.status)
        : f === 'waiting' ? ['queued', 'retry-wait', 'paused'].includes(t.status)
          : f === 'attention' ? t.status === 'failed'
            : t.status === f)
  );
  const count = f => state.tasks.filter(t => match(t, f)).length;
  const visible = state.tasks.filter(
    t => match(t, filter)
      && (platform === '全部平台' || t.item.platform === platform)
      && `${t.item.title} ${t.item.author}`.toLowerCase().includes(query.toLowerCase()),
  );
  const detail = state.tasks.find(t => t.id === detailId);

  const filterTabs = [
    ['all', '全部', ''],
    ['running', '下载中', 'tone-running'],
    ['waiting', '等待 / 暂停', ''],
    ['completed', '已完成', 'tone-completed'],
    ['attention', '需处理', 'tone-attention'],
    ['cancelled', '已取消', ''],
  ];

  return (
    <>
      <Heading
        title="任务中心"
        subtitle="下载进度、自动排队与失败恢复"
        action={<Button variant="primary" onClick={newDownload}><Plus size={16} />新建下载</Button>}
      />
      <div className="scheduler-summary">
        <span>调度策略：{concurrencyLabel(state.settings.concurrency)}</span>
        <strong>正在执行 {state.scheduler?.active || 0} 个</strong>
        <span>排队等待 {state.scheduler?.waiting || 0} 个</span>
        <small>{state.scheduler?.cooldowns?.length ? `平台冷却：${state.scheduler.cooldowns.map(c => c.platform).join('、')}` : state.scheduler?.reason}</small>
      </div>
      <div className="task-filter-cards" role="tablist" aria-label="任务状态筛选">
        {filterTabs.map(([f, label, tone]) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            className={`task-filter-card ${tone} ${filter === f ? 'selected' : ''}`}
            onClick={() => setFilter(f)}
          >
            <span>{label}</span>
            <strong>{count(f)}</strong>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="search">
          <Search size={16} />
          <input placeholder="搜索视频标题、作者…" aria-label="搜索任务" value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <select aria-label="任务平台" value={platform} onChange={e => setPlatform(e.target.value)}>
          <option>全部平台</option>
          {PLATFORMS.map(p => <option key={p}>{p}</option>)}
        </select>
        <Button disabled={!count('running')} onClick={() => state.tasks.filter(t => match(t, 'running')).forEach(t => safe('action', t.id, 'pause'))}>
          <Pause size={15} />暂停下载任务
        </Button>
        <Button disabled={!count('attention')} onClick={() => state.tasks.filter(t => t.status === 'failed').forEach(t => safe('action', t.id, 'retry'))}>
          <RotateCw size={15} />重试失败任务
        </Button>
      </div>
      {removal.toolbar(visible)}
      {removal.dialog}

      <div className={`task-layout ${detail ? 'with-detail' : ''}`}>
        <div className="task-list">
          {visible.length ? visible.map(t => {
            const p = t.progress;
            const ratio = p.total ? Math.min(100, Math.round(p.bytes / p.total * 100)) : null;
            return (
              <section key={t.id} className={`panel task-row ${detailId === t.id ? 'picked' : ''}`}>
                {removal.checkbox(t)}
                <Thumb item={t.item} />
                <div className="task-info">
                  <h3 title={t.item.title}>{t.item.title}</h3>
                  <p><Platform name={t.item.platform} /><span>{t.item.author}</span></p>
                  <span className="task-size">{t.filePath ? bytes(t.size) : `${bytes(p.bytes)} / ${bytes(p.total)}`}</span>
                </div>
                <div className="task-progress">
                  <span className={`task-status ${t.status}`}><StatusIcon status={t.status} />{STATUS[t.status]}</span>
                  {['downloading', 'processing', 'retry-wait'].includes(t.status) && (
                    <div className={`progress ${t.status === 'processing' || ratio === null ? 'indeterminate' : ''}`}>
                      <i style={{ width: `${ratio ?? 35}%` }} />
                    </div>
                  )}
                  <p>
                    {t.status === 'downloading'
                      ? `${ratio === null ? '获取媒体大小…' : `${ratio}%`}${p.speed ? ` · ${bytes(p.speed)}/s` : ''}`
                      : t.status === 'retry-wait'
                        ? `稍后自动重试 · 已尝试 ${t.attempts} 次`
                        : t.message}
                  </p>
                </div>
                <div className="task-actions">
                  {['downloading', 'processing'].includes(t.status) ? (
                    <Button onClick={() => safe('action', t.id, 'pause')}><Pause size={15} />暂停</Button>
                  ) : ['failed', 'cancelled', 'paused'].includes(t.status) ? (
                    <Button onClick={() => (t.error?.category === 'auth' ? accounts(t.item.platform) : safe('action', t.id, t.status === 'paused' ? 'resume' : 'retry'))}>
                      {t.error?.category === 'auth' ? <LogIn size={15} /> : <RotateCw size={15} />}
                      {t.error?.category === 'auth' ? '去登录' : t.status === 'paused' && t.item.platform === '视频号' ? '重新下载' : t.status === 'paused' ? '继续' : '重试'}
                    </Button>
                  ) : t.status === 'completed' ? (
                    <Button onClick={() => safe('locateFile', t.item.key)}><FolderOpen size={15} />定位文件</Button>
                  ) : (
                    <Button onClick={() => safe('action', t.id, 'cancel')}><X size={15} />取消</Button>
                  )}
                  {t.status === 'failed' && t.error?.category === 'auth' && (
                    <button className="text-button" onClick={() => safe('action', t.id, 'retry')}>登录后重试</button>
                  )}
                  <div className="page-heading-actions">
                    <button className="text-button" onClick={() => setDetailId(t.id)}>查看详情</button>
                    {removal.removeButton(t)}
                  </div>
                </div>
              </section>
            );
          }) : (
            <section className="panel">
              <Empty
                icon={ListTodo}
                title={state.tasks.length ? '没有符合条件的任务' : '下载队列还是空的'}
                text="确认视频条目后，下载任务会显示在这里。"
                action={<Button variant="primary" onClick={newDownload}>粘贴视频链接</Button>}
              />
            </section>
          )}
        </div>

        {detail && (
          <aside className="panel task-detail">
            <div className="section-title">
              <h2>任务详情</h2>
              <button className="icon-button" aria-label="关闭详情" onClick={() => setDetailId(null)}><X size={16} /></button>
            </div>
            <Thumb item={detail.item} />
            <h3>{detail.item.title}</h3>
            <p><Platform name={detail.item.platform} /></p>
            <dl>
              <dt>状态</dt><dd>{STATUS[detail.status]}</dd>
              <dt>创建时间</dt><dd>{date(detail.createdAt)}</dd>
              <dt>尝试次数</dt><dd>{detail.attempts} 次</dd>
              <dt>保存目录</dt><dd className="path" title={detail.options.savePath}>{detail.options.savePath}</dd>
            </dl>
            {detail.error && <div className="error-box"><AlertCircle size={16} /><p>{detail.error.message}</p></div>}
            {detail.logs && <details><summary>查看诊断信息</summary><pre>{detail.logs}</pre></details>}
            <Button onClick={() => safe('openSource', detail.item.url)}><ExternalLink size={15} />打开原页面</Button>
            {detail.status !== 'completed' && detail.status !== 'cancelled' && (
              <Button variant="quiet" onClick={() => safe('action', detail.id, 'cancel')}>取消此任务</Button>
            )}
          </aside>
        )}
      </div>
    </>
  );
}

function StatusIcon({ status }) {
  const Icon = status === 'completed' ? CheckCircle2 : status === 'failed' ? AlertCircle : status === 'paused' ? Pause : status === 'processing' ? LoaderCircle : status === 'downloading' ? Download : Clock;
  return <Icon size={14} className={status === 'processing' ? 'spin' : ''} />;
}

function MediaLibrary({ onVideo, state, safe, perform, notify, newDownload, transcribe }) {
  const removal = useRecordRemoval('media', state.media, perform, notify);
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('全部平台');
  const [author, setAuthor] = useState('全部作者');
  const [collection, setCollection] = useState('全部合集');
  const [time, setTime] = useState('all');
  const [grid, setGrid] = useState(true);
  const [sort, setSort] = useState('recent');
  const [edit, setEdit] = useState(null);
  const [tagText, setTagText] = useState('');

  const authors = [...new Set(state.media.map(m => m.author).filter(Boolean))];
  const collections = [...new Set(state.media.map(m => m.collection).filter(Boolean))];
  const hasFilters = platform !== '全部平台' || author !== '全部作者' || collection !== '全部合集' || time !== 'all' || query.trim() !== '';

  const media = useMemo(() => (
    state.media
      .filter(m => (
        (platform === '全部平台' || m.platform === platform)
        && (author === '全部作者' || m.author === author)
        && (collection === '全部合集' || m.collection === collection)
        && (time === 'all' || Date.now() - m.downloadedAt <= Number(time) * 86400000)
        && `${m.title} ${m.author} ${(m.tags || []).join(' ')}`.toLowerCase().includes(query.toLowerCase())
      ))
      .sort((a, b) => (sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') : sort === 'old' ? a.downloadedAt - b.downloadedAt : b.downloadedAt - a.downloadedAt))
  ), [state.media, query, platform, author, collection, time, sort]);

  return (
    <>
      <Heading
        title="媒体库"
        subtitle="管理已下载的视频、标签与后续创作"
        action={<Button variant="primary" onClick={() => safe('locateFile', null)}><FolderOpen size={16} />打开保存目录</Button>}
      />

      <section className="panel library-toolbar">
        <div className="library-toolbar-top">
          <label className="search library-search">
            <Search size={17} />
            <input placeholder="搜索标题、作者、标签" aria-label="搜索媒体" value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          <div className="view-options">
            <select aria-label="媒体排序" value={sort} onChange={e => setSort(e.target.value)}>
              <option value="recent">最近下载</option>
              <option value="old">最早下载</option>
              <option value="name">标题排序</option>
            </select>
            <button className={`icon-button ${grid ? 'selected' : ''}`} aria-label="网格视图" onClick={() => setGrid(true)}><Grid2X2 size={16} /></button>
            <button className={`icon-button ${!grid ? 'selected' : ''}`} aria-label="列表视图" onClick={() => setGrid(false)}><List size={16} /></button>
          </div>
        </div>
        <div className="library-filters">
          <label>平台
            <select value={platform} onChange={e => setPlatform(e.target.value)}>
              <option>全部平台</option>
              {PLATFORMS.map(p => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>作者
            <select value={author} onChange={e => setAuthor(e.target.value)}>
              <option>全部作者</option>
              {authors.map(a => <option key={a}>{a}</option>)}
            </select>
          </label>
          <label>合集
            <select value={collection} onChange={e => setCollection(e.target.value)}>
              <option>全部合集</option>
              {collections.map(c => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label>下载时间
            <select value={time} onChange={e => setTime(e.target.value)}>
              <option value="all">全部时间</option>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
            </select>
          </label>
          {hasFilters && (
            <button className="text-button" onClick={() => { setPlatform('全部平台'); setAuthor('全部作者'); setCollection('全部合集'); setTime('all'); setQuery(''); }}>
              清除筛选
            </button>
          )}
        </div>
      </section>

      {removal.toolbar(media)}
      {removal.dialog}

      <p className="result-count">找到 {media.length} 个视频</p>

      {media.length ? (
        <div className={grid ? 'media-grid' : 'media-list'}>
          {media.map(m => (
            <article className="panel media-card" key={m.id} data-media-id={m.id} data-media-type="video" data-media-title={m.title}>
              <div className="media-card-top">
                <label className="media-record-select">{removal.checkbox(m)}选择</label>
                <Platform name={m.platform} />
              </div>
              <button type="button" className="media-cover" data-media-preview-trigger aria-label={`放大播放${m.title}`}>
                <Thumb item={m} />
                {!m.exists && <Badge tone="amber">文件缺失或已变更</Badge>}
              </button>
              <div className="media-body">
                <div className="media-title">
                  <h3 title={m.title}>{m.title}</h3>
                </div>
                <p>{m.author || '未知作者'} · {m.height ? `${m.height}p` : '画质未标注'} · {bytes(m.size)}</p>
                <p className="media-date">下载于 {new Date(m.downloadedAt).toLocaleDateString('zh-CN')}</p>
                <div className="media-tags">
                  {(m.tags || []).map(t => <span key={t}>{t}</span>)}
                  <button aria-label="编辑标签" onClick={() => { setEdit(m); setTagText((m.tags || []).join(', ')); }}>
                    <Tag size={12} />{m.tags?.length ? '' : '添加标签'}
                  </button>
                </div>
                <div className="media-actions">
                  <div className="media-actions-primary">
                    <Button variant="primary" disabled={!m.exists} onClick={() => safe('openFile', m.id)}>
                      <Play size={14} />播放
                    </Button>
                    <Button onClick={() => safe(m.exists ? 'locateFile' : 'relocate', m.id)}>
                      {m.exists ? <FolderOpen size={14} /> : <RotateCw size={14} />}
                      {m.exists ? '定位文件' : '重新定位'}
                    </Button>
                  </div>
                  <div className="media-actions-secondary">
                    <Button disabled={!m.exists} onClick={() => onVideo({ mediaId: m.id, title: m.title })}>对标二创</Button>
                    <Button disabled={!m.exists} onClick={() => transcribe(m.id)}><FileText size={13} />转录与翻译</Button>
                    <div className="media-actions-tail">
                      <button className="icon-button" aria-label="打开视频原页面" title="打开原页面" onClick={() => safe('openSource', m.url)}>
                        <ExternalLink size={14} />
                      </button>
                      {removal.removeButton(m)}
                    </div>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon={Library}
            title={state.media.length ? '没有匹配的视频' : '下载完成后，视频会出现在这里'}
            text="视频通过媒体校验后自动入库，支持按平台、作者、合集和下载时间组合查找。"
            action={!state.media.length && <Button variant="primary" onClick={newDownload}>开始下载</Button>}
          />
        </section>
      )}

      {edit && (
        <Modal title="编辑视频标签" close={() => setEdit(null)}>
          <p>{edit.title}</p>
          <label>
            标签
            <input className="full-input" value={tagText} onChange={e => setTagText(e.target.value)} placeholder="旅行, 素材, 待整理" />
          </label>
          <p className="hint">使用逗号分隔，最多 12 个标签。</p>
          <div className="modal-actions">
            <Button onClick={() => setEdit(null)}>取消</Button>
            <Button variant="primary" onClick={async () => { try { await perform('updateTags', edit.id, tagText); setEdit(null); notify('标签已保存'); } catch {} }}>
              保存标签
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Accounts({ state, safe, perform, notify, filter, setFilter }) {
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState('视频号');
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [removeError, setRemoveError] = useState(null);

  const visible = state.accounts.filter(a => filter === '全部平台' || a.platform === filter);
  const browserLogin = useAccountBrowserLogin(perform, notify);

  return (
    <>
      <Heading
        title="账号管理"
        subtitle="统一管理各平台本机登录会话，采集与下载自动复用"
        action={
          <Button variant="primary" onClick={() => { setPlatform(filter === '全部平台' ? '视频号' : filter); setAdding(true); }}>
            <Plus size={16} />添加账号
          </Button>
        }
      />

      <ExternalBrowserStatus perform={perform} accounts={state.accounts} />

      <div className="task-tabs account-tabs">
        {['全部平台', ...PLATFORMS].map(p => {
          const count = p === '全部平台' ? state.accounts.length : state.accounts.filter(a => a.platform === p).length;
          return (
            <button key={p} className={filter === p ? 'selected' : ''} onClick={() => setFilter(p)}>
              {p} {count > 0 && <small>{count}</small>}
            </button>
          );
        })}
      </div>

      <div className="account-layout">
        <div className="account-list">
          {visible.length ? visible.map(a => (
            <section className="panel account-row" key={a.id}>
              <div className={`account-symbol ${PLATFORM_CLASS[a.platform]}`}><Users size={21} /></div>
              <div className="account-info">
                <h3>
                  {a.name}
                  {a.active && <Badge tone="blue">下载使用中</Badge>}
                  <Badge tone={a.status === '需要重新登录' ? 'amber' : a.status === '最近解析成功' ? 'green' : ''}>{a.status}</Badge>
                </h3>
                <p>
                  <Platform name={a.platform} />
                  <span>{a.message || '在官方窗口完成登录，再保存本机会话'}</span>
                </p>
                <small>
                  {a.lastVerified ? `最近解析成功：${date(a.lastVerified)}` : a.lastSync ? `会话保存于：${date(a.lastSync)}` : '尚未保存登录会话'}
                </small>
              </div>
              <div className="account-actions">
                <AccountBrowserActions account={a} login={browserLogin} />
                <div className="account-actions-links">
                  {!a.active && <button className="text-button" onClick={() => safe('accountAction', a.id, 'select')}>设为下载账号</button>}
                  <button
                    className="text-button"
                    onClick={async () => {
                      try {
                        const r = await perform('importAccount', a.id);
                        if (r) notify('选定会话已导入，实际有效性将在解析时验证');
                      } catch {}
                    }}
                  >
                    导入会话文件
                  </button>
                  {a.lastSync && <button className="text-button muted" onClick={() => safe('accountAction', a.id, 'logout')}>退出账号</button>}
                  <button className="text-button record-remove" onClick={() => { setRemoveError(null); setRemoving(a); }}>删除账号及会话</button>
                </div>
              </div>
            </section>
          )) : (
            <section className="panel">
              <Empty
                icon={Users}
                title="还没有添加平台账号"
                text="公开视频可以先尝试无账号下载；需要登录时，在这里添加独立的平台账号。"
                action={<Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} />添加账号</Button>}
              />
            </section>
          )}
        </div>

        <aside className="panel account-guide">
          <h2>登录怎么操作</h2>
          {['选择平台并添加账号', '在打开的官方网页中完成登录', '返回软件自动检测并保存会话', '后续下载与采集自动复用会话'].map((t, i) => (
            <div className="guide-step" key={t}><b>{i + 1}</b><span>{t}</span></div>
          ))}
          <div className="soft-note">
            <CircleHelp size={16} />
            <span>浏览器已接入仅表示连接可用；平台登录状态以检测与实际采集结果为准。</span>
          </div>
        </aside>
      </div>

      {removing && (
        <Modal title="删除账号及本机会话" close={() => { if (!deleting) setRemoving(null); }}>
          <p>删除“{removing.name}”（{removing.platform}）在本应用中的账号记录和登录会话？</p>
          <p>已下载视频、下载任务、文案和转写结果保留。不会注销平台账号，也不会退出外部浏览器或微信的登录。</p>
          <p className="hint">删除下载使用中的账号后，需要在剩余账号中重新选择，或重新添加账号。</p>
          {removeError && <p role="alert">{removeError}</p>}
          <div className="modal-actions">
            <Button autoFocus disabled={deleting} onClick={() => setRemoving(null)}>取消</Button>
            <Button
              variant="danger"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                setRemoveError(null);
                try {
                  await perform('accountAction', removing.id, 'remove');
                  setRemoving(null);
                  notify('账号记录及本机登录会话已删除');
                } catch (e) {
                  setRemoveError(e.message);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? '正在删除…' : '确认删除账号及会话'}
            </Button>
          </div>
        </Modal>
      )}

      {adding && (
        <Modal title="添加平台账号" close={() => setAdding(false)}>
          <label>
            平台
            <select className="full-input" value={platform} onChange={e => setPlatform(e.target.value)}>
              {PLATFORMS.map(p => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>
            账号备注
            <input className="full-input" autoFocus placeholder="例如：工作账号、素材账号" value={name} maxLength={40} onChange={e => setName(e.target.value)} />
          </label>
          <p className="hint">同一平台可添加多个账号，每个平台选一个用于下载。</p>
          <div className="modal-actions">
            <Button onClick={() => setAdding(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  const a = await perform('addAccount', platform, name);
                  setAdding(false);
                  setName('');
                  await browserLogin.open(a);
                } catch {}
              }}
            >
              添加并打开官方登录
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Preferences({ state, perform, safe, notify, accounts, section }) {
  const [draft, setDraft] = useState(state.settings);
  const [saving, setSaving] = useState(false);
  const settingsKey = JSON.stringify(state.settings);
  useEffect(() => setDraft(state.settings), [settingsKey]);
  const update = (key, value) => setDraft(p => ({ ...p, [key]: value }));

  return (
    <>
      <div className="preferences-layout">
        <div hidden={section !== 'download'}>
          <section className="panel settings-card">
            <h2><SlidersHorizontal size={18} />下载设置</h2>
            <label className="setting-row">
              <span>保存目录<small>新任务生效，已有文件不会自动搬迁</small></span>
              <div className="folder-input">
                <input aria-label="默认保存目录" title={draft.savePath} value={draft.savePath} readOnly />
                <button aria-label="选择默认保存目录" onClick={async () => { try { const p = await perform('chooseFolder'); if (p) update('savePath', p); } catch {} }}>
                  <FolderOpen size={17} />
                </button>
              </div>
            </label>
            <label className="setting-row">
              <span>同时下载<small>支持自动或 1—99 上限；实际并发按资源和平台调整，超出部分排队</small></span>
              <select aria-label="同时下载上限" value={draft.concurrency} onChange={e => update('concurrency', e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
                <option value="auto">自动调度（推荐）</option>
                {Array.from({ length: 99 }, (_, i) => i + 1).map(n => <option value={n} key={n}>上限 {n} 个</option>)}
              </select>
            </label>
            <label className="setting-row">
              <span>默认画质<small>不会超过源站实际提供的画质</small></span>
              <select aria-label="默认画质" value={draft.quality} onChange={e => update('quality', e.target.value)}>
                <option value="best">最高可用</option>
                <option value="1080">1080p 以内</option>
                <option value="720">720p 以内</option>
                <option value="480">480p 以内</option>
              </select>
            </label>
            <label className="setting-row">
              <span>自动失败重试<small>仅对网络中断或限流生效</small></span>
              <select aria-label="自动失败重试" value={draft.retries} onChange={e => update('retries', Number(e.target.value))}>
                {[0, 1, 2, 3, 4, 5].map(n => <option value={n} key={n}>{n} 次</option>)}
              </select>
            </label>
            <label className="setting-row">
              <span>自动归档</span>
              <select aria-label="下载文件归档规则" value={draft.archive} onChange={e => update('archive', e.target.value)}>
                <option value="collection">平台 / 作者 / 合集</option>
                <option value="author">平台 / 作者</option>
                <option value="flat">直接保存到目录</option>
              </select>
            </label>
            <label className="setting-row">
              <span>跳过重复视频<small>已有完整文件存在时跳过；可以单次另存一份</small></span>
              <input className="switch" aria-label="跳过重复视频" type="checkbox" checked={draft.skipDuplicates} onChange={e => update('skipDuplicates', e.target.checked)} />
            </label>
          </section>

          <section className="panel settings-card">
            <div className="section-title">
              <h2><Users size={18} />平台账号</h2>
              <button className="text-button" onClick={() => accounts()}>前往账号管理</button>
            </div>
            {PLATFORMS.map(p => {
              const a = state.accounts.find(acc => acc.platform === p && acc.active);
              return (
                <div className="platform-setting" key={p}>
                  <Platform name={p} />
                  <span>{a ? `${a.name} · ${a.status}` : '未配置账号，可先尝试公开视频'}</span>
                  <button className="text-button" onClick={() => accounts(p)}>管理账号<ChevronRight size={14} /></button>
                </div>
              );
            })}
          </section>
        </div>

        <div hidden={section !== 'application'}>
          <section className="panel settings-card environment">
            <div className="section-title">
              <h2>下载组件</h2>
              <button className="text-button" onClick={() => safe('environment')}>检查环境</button>
            </div>
            {state.environment.length ? state.environment.map(c => (
              <div key={c.name}>
                <span>
                  {c.ok ? <CheckCircle2 className="green-text" size={16} /> : <AlertCircle className="amber-text" size={16} />}
                  <strong>{c.name}</strong>
                </span>
                <p>{c.version}</p>
              </div>
            )) : <p className="hint">正在检查…</p>}
            <div className="soft-note">引擎、合并工具和运行环境随安装包提供。</div>
          </section>

          <section className="panel settings-card">
            <h2>应用设置</h2>
            <p className="hint">当前版本 · {state.version}</p>
            <label className="setting-row">
              <span>开机启动<small>仅安装版生效</small></span>
              <input className="switch" aria-label="开机启动" type="checkbox" checked={draft.autoStart} onChange={e => update('autoStart', e.target.checked)} />
            </label>
            <p className="hint">下载、搜索、评论采集或私信等任务进行中时，关闭窗口会先询问。</p>
            <p className="hint">剪贴板采用手动粘贴，不会在后台监听。</p>
          </section>
        </div>
      </div>

      <div className="selection-footer">
        <p>{section === 'download' ? '更改下载目录不会移动已有视频' : '应用偏好保存在本机'}</p>
        <Button
          variant="primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await perform('saveSettings', draft);
              notify(section === 'application' ? '应用设置已保存' : '设置已保存，新任务将使用新的下载偏好');
            } catch {} finally {
              setSaving(false);
            }
          }}
        >
          {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存设置
        </Button>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
