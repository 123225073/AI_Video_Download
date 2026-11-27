import React, { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import './CollectorConnectionPrompt.css';

function formatClock(ts) {
  try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }); }
  catch { return ''; }
}

export default function CollectorConnectionPrompt({ connection, perform, onStop, stopping = false, onUseCollected, collectedLabel, collectedUnavailable, error }) {
  const titleId = useId(), dialog = useRef(null), checking = useRef(false), mounted = useRef(false);
  const [detecting, setDetecting] = useState(false), [message, setMessage] = useState('');
  const [probe, setProbe] = useState(null), [probeCount, setProbeCount] = useState(0);
  const action = useRef(null), [acting, setActing] = useState(null);
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
  async function performAction(kind, fn) {
    if (action.current || checking.current || stopping) return;
    action.current = kind; setActing(kind); setMessage('');
    try { await fn(); }
    catch (error) { if (mounted.current) setMessage(error.message); }
    finally { action.current = null; if (mounted.current) setActing(null); }
  }
  async function openPage() {
    try {
      setMessage('正在向电脑微信发送打开请求…');
      await perform('collectorOpenPage');
      if (mounted.current) setMessage('已发送微信打开请求，尚未确认视频号窗口已打开。若未出现视频号窗口，请手动在电脑微信左侧进入“视频号”（新版内嵌页可点右上角“独立窗口打开”或先切“朋友圈”再点回“视频号”），再返回检测。');
    }
    catch (error) { if (mounted.current) setMessage(error.message); }
  }
  async function detect() {
    if (checking.current || action.current || stopping) return;
    checking.current = true; setDetecting(true);
    const nextCount = probeCount + 1;
    setMessage(`正在执行第 ${nextCount} 次实时连接检测，原任务保持等待…`);
    const startedAt = Date.now();
    try {
      const status = await perform('collectorStatus');
      const elapsed = Date.now() - startedAt;
      if (elapsed < 180) await new Promise(resolve => setTimeout(resolve, 180 - elapsed));
      if (!mounted.current) return;
      const clock = formatClock(status?.checkedAt || Date.now());
      setProbeCount(nextCount);
      setProbe(status || null);
      if (status?.connected) {
        setMessage(`${clock}（第 ${nextCount} 次检测）：已检测到视频号页面连接${status.adapterReady ? '且接口就绪' : ''}，原任务会在所需接口就绪后自动继续。`);
      } else if (status?.ready === false) {
        setMessage(`${clock}（第 ${nextCount} 次检测）：尚未检测到本机采集服务响应；请稍候再试，或停止后重新发起读取。`);
      } else if (status && 'proxyListening' in status && !status.proxyListening) {
        setMessage(`${clock}（第 ${nextCount} 次检测）：采集服务在线，但微信代理分流通道尚未就绪，尚未检测到视频号页面连接；请稍候或停止后重试。`);
      } else {
        setMessage(`${clock}（第 ${nextCount} 次检测）：采集服务与分流已就绪，但仍未收到微信视频号页面回连。新版微信 4.2 首次连接若切换“朋友圈 → 视频号”仍未接通，请右键任务栏托盘彻底退出微信再重新打开进入视频号（清理旧缓存，仅需一次）。`);
      }
    } catch (error) { if (mounted.current) setMessage(error.message); }
    finally { checking.current = false; if (mounted.current) setDetecting(false); }
  }
  function keepFocus(event) {
    if (event.key === 'Escape') { event.preventDefault(); performAction('stop', onStop); return; }
    if (event.key !== 'Tab') return;
    const buttons = [...dialog.current.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const serviceOk = probe ? probe.ready !== false : true;
  const proxyOk = probe && 'proxyListening' in probe ? Boolean(probe.proxyListening) : true;
  const pageOk = Boolean(probe?.connected);
  return <div className="collector-prompt-backdrop">
    <section ref={dialog} className="collector-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={keepFocus}>
      <div className="collector-prompt-head">
        <h2 id={titleId}>正在自动连接微信视频号</h2>
        {hasDeadline && <span className={`collector-prompt-timer ${remaining === 0 ? 'expired' : ''}`}>{remaining > 0 ? `剩余等待 ${remaining} 秒` : '已超时'}</span>}
      </div>
      <div className="collector-prompt-checks" aria-label="连接实时状态">
        <span className={`collector-check-pill ${serviceOk ? 'ok' : 'warn'}`}><i/>采集服务：{serviceOk ? '已就绪' : '未响应'}</span>
        <span className={`collector-check-pill ${proxyOk ? 'ok' : 'warn'}`}><i/>分流通道：{proxyOk ? '已开启' : '未监听'}</span>
        <span className={`collector-check-pill ${pageOk ? 'ok' : 'pending'}`}><i/>微信页面：{pageOk ? '已连接' : '等待重载'}</span>
      </div>
      <p className="collector-prompt-lead">{connection.label || '原任务正在等待微信视频号连接。'}</p>
      {hasDeadline && remaining === 0 && <p className="collector-prompt-timeout">等待已超时，正在等待后台返回原因；已有结果保留。</p>}
      <ol>
        <li><strong>确保打开官方视频号窗口</strong>：微信未登录时先完成登录，未出现视频号可点击下方“打开微信视频号”；保持窗口打开，浏览器分享页无法建立连接。</li>
        <li><strong>触发一次视频号页面重新加载（关键）</strong>：连接开启前已打开的旧页面无法自动接入。<strong>新版微信（4.2 内嵌视频号）</strong>请先点左侧“朋友圈”再点回“视频号”（即关闭视频号页面后重新进入）或点右上角“独立窗口打开”；若微信刚升级到 4.2 且首次仍未接通，请<strong>右键右下角托盘退出微信后重开一次</strong>以清理旧缓存（仅需一次）。<strong>旧版独立窗口</strong>可在右上角菜单选择“刷新”。仅切换播放中的视频不能建立连接。</li>
        <li><strong>自动接入并继续任务</strong>：重载页面后软件会自动持续检测，连接就绪后原任务自动继续；也可随时点击“立即检测”查看最新实时状态。</li>
      </ol>
      <p className={`collector-prompt-status ${probeCount > 0 ? 'checked' : ''}`} role="status" aria-live="polite">{message || error || '等待期间已有结果保留；无需关闭代理软件或反复登录。'}</p>
      {collectedUnavailable && <p>{collectedUnavailable}</p>}
      <div className="collector-prompt-actions">
        <button className="button primary" disabled={!!acting || detecting || stopping} onClick={()=>performAction('open',openPage)}><ExternalLink size={16}/>打开微信视频号</button>
        <button className="button" disabled={!!acting || detecting || stopping} onClick={detect}>{detecting ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={15}/>}{detecting ? '正在检测…' : '立即检测'}</button>
        {onUseCollected && <button className="button primary" disabled={!!acting || detecting || stopping} onClick={()=>performAction('use',onUseCollected)}>{acting==='use'?'正在使用已有内容…':collectedLabel||'直接使用已采集内容'}</button>}
        <button className="button" disabled={!!acting || detecting || stopping} onClick={()=>performAction('stop',onStop)}><Square size={16}/>{stopping||acting==='stop' ? '正在停止…' : '停止并保留已有结果'}</button>
      </div>
      <small>当前播放哪个视频不影响识别，作者以下载器中粘贴的原链接为准。若等待超时，已读取清单保留；请先重新识别或继续读取，等连接提示出现后再重载视频号页面。</small>
    </section>
  </div>;
}
