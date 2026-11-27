import React, {useEffect, useState} from 'react';
import {History, MessagesSquare, Search} from 'lucide-react';

export default function CommentHistory({record, busy, perform, onSelect, onSearch}) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    perform('commentsHistory').then(rows => {if (current) setHistory(rows);})
      .catch(e => {if (current) setError(e.message);})
      .finally(() => {if (current) setLoading(false);});
    return () => {current = false;};
  }, [record?.id, record?.status]);
  async function select(id) {
    setSelecting(true);
    setError('');
    try { onSelect(await perform('commentsSelect', id)); }
    catch (e) { setError(e.message); }
    finally { setSelecting(false); }
  }
  return <>
    <div className="history-bar"><label><History size={17}/>采集记录
      <select aria-label="选择历史评论记录" disabled={busy || selecting || !history.length} value={record?.id || ''}
        onChange={e => select(e.target.value)}>
        {!history.some(r => r.id === record?.id) && <option value={record?.id || ''}>{record?.source?.title || (loading ? '正在读取…' : '暂无记录')}</option>}
        {history.map(r => <option value={r.id} key={r.id}>{r.platform} · {r.title || '未返回标题'} · {r.count} 条 · {r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN',{hour12:false}) : ''}</option>)}
      </select></label>{record && <button className="text-button" onClick={onSearch}><Search size={15}/>查找其他作品</button>}</div>
    {error && <p className="creator-notice" role="alert">{error}</p>}
    {!record && !loading && <section className="panel empty comments-intro"><span className="empty-icon"><MessagesSquare size={29}/></span>
      <h1>评论与私信</h1><p>先搜索作品，再点击作品上的“一键采集评论”。采集后可以按关键词筛选评论、查看用户和准备私信。</p>
      <button className="button primary" onClick={onSearch}><Search size={16}/>前往作品搜索</button>
    </section>}
  </>;
}
