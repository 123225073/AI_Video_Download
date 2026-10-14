import React, { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, Square } from 'lucide-react';
import './CollectorConnectionPrompt.css';

export default function CollectorConnectionPrompt({ connection, perform, onStop, stopping = false }) {
  const titleId = useId(), dialog = useRef(null), checking = useRef(false), mounted = useRef(false);
  const [detecting, setDetecting] = useState(false), [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now);
  const deadline = Number(connection.waitingUntil);
  const hasDeadline = Number.isFinite(deadline) && deadline > 0;
  const remaining = hasDeadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
  useEffect(() => {
    if (!hasDeadline) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline, hasDeadline]);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    return () => { mounted.current = false; if (previous?.isConnected) previous.focus(); };
  }, []);
  async function openPage() {
    try {
      setMessage('正在向电脑微信发送打开请求…');
      await perform('collectorOpenPage');
      if (mounted.current) setMessage('已发送微信打开请求，尚未确认视频号窗口已打开。若未出现视频号窗口，请手动在电脑微信左侧进入“视频号”，再返回检测。');
    }
    catch (error) { if (mounted.current) setMessage(error.message); }
  }
  async function detect() {
    if (checking.current || stopping) return;
    checking.current = true; setDetecting(true); setMessage('正在检测当前连接，原任务保持等待…');
    try {
      const status = await perform('collectorStatus');
      if (mounted.current) setMessage(status?.connected
        ? '已检测到视频号页面连接，原任务会在所需接口就绪后自动继续。'
        : '尚未检测到视频号页面连接。请从官方视频号窗口菜单刷新；无效时关闭视频号页面后重新进入，再继续检测。');
    } catch (error) { if (mounted.current) setMessage(error.message); }
    finally { checking.current = false; if (mounted.current) setDetecting(false); }
  }
  function keepFocus(event) {
    if (event.key !== 'Tab') return;
    const buttons = [...dialog.current.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <div className="collector-prompt-backdrop">
    <section ref={dialog} className="collector-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={keepFocus}>
      <h2 id={titleId}>需要在微信视频号窗口完成连接</h2>
      <p>{connection.label || '原任务正在等待微信视频号连接。'}</p>
      {hasDeadline && <p>{remaining > 0 ? `剩余等待 ${remaining} 秒；完成以下操作后会自动继续。` : '等待已超时，正在等待后台返回原因；已有结果保留。'}</p>}
      <ol>
        <li>点击“打开微信视频号”尝试唤起微信；未自动进入时，在电脑微信左侧选择“视频号”。微信未登录时，完成官方登录。</li>
        <li>保持微信的官方视频号窗口打开，不要关闭窗口；仅打开浏览器分享页不能完成连接。</li>
        <li>在倒计时结束前，用视频号窗口菜单选择“刷新”；没有刷新选项或刷新无效时，关闭视频号页面后重新进入（不用退出微信）。仅切换正在播放的视频不能建立连接。</li>
        <li>完成后点击“已操作，继续检测”。连接就绪后原任务自动继续，不会重新启动识别或作品读取。</li>
      </ol>
      <p role="status" aria-live="polite">{message || '等待期间已有结果保留；无需关闭代理软件或反复登录。'}</p>
      <div className="collector-prompt-actions">
        <button className="button primary" disabled={stopping} onClick={openPage}><ExternalLink size={16}/>打开微信视频号</button>
        <button className="button" disabled={detecting || stopping} onClick={detect}>{detecting && <LoaderCircle className="spin" size={16}/>}{detecting ? '正在检测…' : '已操作，继续检测'}</button>
        <button className="button" disabled={stopping} onClick={onStop}><Square size={16}/>{stopping ? '正在停止…' : '停止并保留已有结果'}</button>
      </div>
      <small>当前播放哪个视频不影响识别，作者以下载器中粘贴的原链接为准。若等待超时，已读取清单保留；请先重新识别或继续读取，等连接提示出现后再刷新视频号。</small>
    </section>
  </div>;
}
