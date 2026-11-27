import React from 'react';
import {
  Wind, Link2, UsersRound, Search, MessagesSquare, ListTodo, LibraryBig,
  BookOpenText, AudioLines, ContactRound, Settings2, CircleHelp, FolderOpen,
  Activity, CheckCheck, ChevronRight
} from 'lucide-react';

const sections = [
  ['内容获取', [
    ['new', Link2, '链接下载'],
    ['creator', UsersRound, '博主批量下载'],
    ['search', Search, '作品搜索与二创'],
    ['comments', MessagesSquare, '评论与私信'],
  ]],
  ['本地资料', [
    ['tasks', ListTodo, '任务中心'],
    ['library', LibraryBig, '媒体库'],
    ['articles', BookOpenText, '文章中心'],
    ['transcription', AudioLines, '转录与翻译'],
  ]],
  ['管理', [
    ['accounts', ContactRound, '账号管理'],
  ]],
];

export function Sidebar({ page, navigate, running, version, settings, help }) {
  const active = page === 'selection' ? 'new' : page === 'archive' ? 'transcription' : page;
  return (
    <aside className="sidebar">
      <div className="brand" title={`风沙全平台视频下载器 v${version}`}>
        <i className="brand-mark">
          <Wind size={22} strokeWidth={2.3} />
          {version && <em className="brand-mark-ver">v{version}</em>}
        </i>
        <div>
          <strong>风沙</strong>
          <span>全平台视频下载器</span>
        </div>
      </div>
      <nav aria-label="工作区导航">
        {sections.map(([group, items]) => (
          <div className="nav-section" key={group}>
            <h2>{group}</h2>
            {items.map(([id, Icon, label]) => (
              <button
                key={id}
                title={label}
                aria-label={label}
                aria-current={active === id ? 'page' : undefined}
                className={active === id ? 'active' : ''}
                onClick={() => navigate(id)}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
                {id === 'tasks' && running > 0 && <b>{running}</b>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          aria-label="设置"
          title="设置"
          aria-current={page === 'settings' ? 'page' : undefined}
          className={page === 'settings' ? 'active' : ''}
          onClick={settings}
        >
          <Settings2 size={17} />
          <span>设置</span>
        </button>
        <button onClick={help} title="帮助与使用说明" aria-label="帮助与使用说明">
          <CircleHelp size={17} />
          <span>帮助与使用说明</span>
        </button>
      </div>
    </aside>
  );
}

export function DownloadHeader({ state, environment, navigate, settings }) {
  const ready = environment.length > 0 && environment.every(item => item.ok);
  const metrics = [
    ['执行中', state.tasks.filter(t => ['downloading', 'processing'].includes(t.status)).length, Activity, 'tasks', 'running'],
    ['已完成', state.tasks.filter(t => t.status === 'completed').length, CheckCheck, 'tasks', 'completed'],
    ['媒体库', state.media.filter(m => m.exists).length, FolderOpen, 'library', undefined],
  ];
  return (
    <header className="download-top-header">
      <div className="download-top-title">
        <h1>链接下载</h1>
        <p>粘贴视频、合集或博主链接，识别确认后自动排队下载。</p>
      </div>
      <div className="download-top-meta">
        <div className="download-quick-stats" aria-label="下载概况">
          {metrics.map(([name, count, Icon, page, filter]) => (
            <button
              key={name}
              title={page === 'tasks' ? '打开任务中心' : '打开媒体库'}
              onClick={() => navigate(page, filter)}
            >
              <Icon size={14} />
              <span>{name}</span>
              <b>{count}</b>
            </button>
          ))}
        </div>
        <button className={`engine-pill ${ready ? 'ready' : ''}`} onClick={settings}>
          <i />
          {ready ? '组件就绪' : environment.length ? '组件异常' : '检查环境'}
          <ChevronRight size={13} />
        </button>
      </div>
    </header>
  );
}
