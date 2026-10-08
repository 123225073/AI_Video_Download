import React, { useEffect, useState } from 'react';
import { Search, Users, ExternalLink, LoaderCircle, AlertCircle, ArrowRight } from 'lucide-react';
import { SEARCH_PLATFORMS } from '../electron/user-search-data.js';
import './user-search.css';

export default function UserSearchPage({ state, perform, safe, identify, accounts, settings, ensureCreatorLogin }) {
  const [platform, setPlatform] = useState('视频号'), [keyword, setKeyword] = useState(''), [record, setRecord] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { perform('userSearchLast').then(r => { if (r) { setRecord(r); setPlatform(r.platform); setKeyword(r.keyword); } }).catch(() => {}); }, []);
  const account = state.accounts.find(a => a.platform === platform && a.active);
  async function search(more = false) {
    const target = more ? record.platform : platform;
    if (target === 'B站' && !ensureCreatorLogin(target)) return;
    setBusy(true); setError('');
    try { setRecord(await perform(more ? 'userSearchMore' : 'userSearch', ...(more ? [record.id] : [platform, keyword]))); }
    catch (e) { setError(e.message); const last = await safe('userSearchLast'); if (last) setRecord(last); }
    finally { setBusy(false); }
  }
  const number = value => value === null ? '平台未公开' : new Intl.NumberFormat('zh-CN').format(value);
  return <div className="user-search-page"><header className="page-heading"><div><h1>用户搜索</h1><p>输入关键词，确认用户身份后读取其发布作品</p></div></header>
    <section className="panel user-search-form"><form onSubmit={e => { e.preventDefault(); if (!busy && keyword.trim()) search(); }}>
      <label>搜索平台<select aria-label="搜索用户平台" value={platform} disabled={busy} onChange={e => setPlatform(e.target.value)}>{SEARCH_PLATFORMS.map(p => <option key={p}>{p}</option>)}</select></label>
      <label className="keyword">用户昵称或关键词<input aria-label="用户搜索关键词" placeholder="例如：AI、摄影、电梯" value={keyword} maxLength={100} disabled={busy} onChange={e => setKeyword(e.target.value)}/></label>
      <button className="button primary" disabled={busy || !keyword.trim() || Boolean(state.creatorProgress || state.parseProgress)}>{busy ? <LoaderCircle size={18} className="spin"/> : <Search size={18}/>}搜索用户</button>
      {busy && <button type="button" className="button" onClick={() => safe('userSearchCancel')}>停止搜索</button>}
    </form><p className="hint">{platform === '视频号' ? '使用本机采集服务和微信中的登录；请保持微信视频号页面打开。' : `使用本应用${account ? `的账号：${account.name}` : '的公开访客会话'}。${platform === 'B站' ? 'B站搜索需先完成账号登录。' : '需要时会打开官方窗口，请本人完成登录或验证。'}`}</p>
    <div className="user-search-links"><button className="text-button" onClick={() => accounts(platform)}>管理 {platform} 账号</button>{platform === '视频号' && <button className="text-button" onClick={settings}>视频号连接设置</button>}</div></section>
    {(error || record?.message) && <div className="creator-notice" role="status"><AlertCircle size={18}/><span>{error || record.message}</span></div>}
    {record && <div className="user-search-summary"><strong>{record.platform} · “{record.keyword}” · 已获取 {record.users.length} 位用户</strong><div>{['抖音', '小红书', 'YouTube'].includes(record.platform) && <button className="button" disabled={busy} onClick={() => safe('userSearchShow')}>显示官方搜索窗口</button>}{record.canContinue && <button className="button" disabled={busy} onClick={() => search(true)}>{['抖音', '小红书', 'YouTube'].includes(record.platform) ? '读取官方页面结果' : '加载更多用户'}</button>}</div></div>}
    <div className="user-search-results">{record?.users.map(user => <article className="panel user-search-card" key={`${user.platform}:${user.id}`}>
      <div className="user-search-avatar">{user.avatar && <img src={user.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" onError={e => { e.currentTarget.hidden = true; }}/>}<Users size={30}/></div>
      <div className="user-search-info"><h3>{user.name}<span className="badge">{user.platform}</span></h3><p className="user-search-id">{user.idKind === 'handle' ? '频道 Handle' : user.idKind === 'sec_uid' ? '用户 sec_uid' : '平台用户 ID'}：{user.id}</p><p>{user.description || '平台未提供简介'}</p>
      <dl><div><dt>{user.platform === 'YouTube' ? '订阅者' : '粉丝'}</dt><dd>{user.followersText || number(user.followers)}</dd></div><div><dt>作品</dt><dd>{user.videosText || number(user.videos)}</dd></div></dl></div>
      <div className="user-search-actions"><button className="button" onClick={() => safe('openSource', user.url)}><ExternalLink size={16}/>查看主页</button><button className="button primary" disabled={busy || Boolean(state.creatorProgress || state.parseProgress)} onClick={() => identify(user.url)}><ArrowRight size={16}/>选择并读取作品</button></div>
    </article>)}</div>
    {!record?.users.length && !busy && <section className="panel"><div className="empty"><Users size={36}/><h3>{record?.status === 'complete' ? '没有匹配用户' : record?.status === 'needs-action' || error ? '等待完成登录或验证' : '先搜索，再确认用户'}</h3><p>同名账号可能有多个，请核对头像、简介和主页。搜索不会自动下载。</p></div></section>}
  </div>;
}
