import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Sparkles, Link, SlidersHorizontal, ChevronRight } from 'lucide-react';
import AISettings from './AISettings.jsx';
import CollectorSettings from './CollectorSettings.jsx';
import './settings-workflow.css';

const sections = [
  { id: 'download', title: '下载与存储', icon: Download, caption: '目录、画质与下载规则', description: '设置新任务的保存位置、画质与下载规则。' },
  { id: 'ai', title: 'AI 模型', icon: Sparkles, caption: 'CPA 生图、豆包配音与转录', description: '管理 CPA 图片二创、豆包声音克隆与合成，以及文本和转录服务。' },
  { id: 'collector', title: '视频号连接', icon: Link, caption: '微信连接与组件检查', description: '管理视频号博主作品读取与下载所需的微信连接。' },
  { id: 'application', title: '应用与组件', icon: SlidersHorizontal, caption: '应用偏好与运行环境', description: '管理应用偏好，查看下载组件与当前版本。' },
];

export default function SettingsPage({ section, select, state, safe, perform, notify, preferences, transcribe, creator }) {
  const [visited, setVisited] = useState(() => new Set([section]));
  const scroll = useRef(null);
  useEffect(() => { setVisited(previous => previous.has(section) ? previous : new Set([...previous, section])); }, [section]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [section]);
  const current = sections.find(item => item.id === section) || sections[0];
  return <section className="settings-workbench">
    <header className="settings-heading"><h1>设置</h1><p>下载、AI 模型与微信连接，统一管理。</p></header>
    <div className="settings-layout">
      <nav className="settings-navigation" aria-label="设置分类">
        <p className="settings-nav-caption">设置分类</p>
        {sections.map(({ id, title, icon: Icon, caption }) => <button key={id} className={current.id === id ? 'selected' : ''} aria-current={current.id === id ? 'page' : undefined} onClick={() => select(id)}>
          <Icon size={20}/><span><strong>{title}</strong><small>{caption}</small></span><ChevronRight size={15}/>
        </button>)}
      </nav>
      <div className="settings-detail">
        <header className="settings-detail-heading"><div><h2>{current.title}</h2><p>{current.description}</p></div>
          {section === 'ai' && <button className="button" onClick={transcribe}><ArrowLeft size={16}/>去转录与翻译</button>}
          {section === 'collector' && <button className="button" onClick={creator}><ArrowLeft size={16}/>去博主批量下载</button>}
        </header>
        <div className="settings-detail-scroll" ref={scroll}>
          <div hidden={!['download', 'application'].includes(section)}>{preferences(section)}</div>
          {(visited.has('ai') || section === 'ai') && <div hidden={section !== 'ai'}><AISettings {...{state, safe, perform, notify}} embedded back={transcribe}/></div>}
          {(visited.has('collector') || section === 'collector') && <div hidden={section !== 'collector'}><CollectorSettings {...{state, perform, notify}} embedded active={section === 'collector'} back={creator}/></div>}
        </div>
      </div>
    </div>
  </section>;
}
