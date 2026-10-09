import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveMedia, zoomLevel } from './media-preview.js';
import './media-preview.css';

const layerSelector = '.media-preview-layer';
const focusable = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], [tabindex]:not([tabindex="-1"])';
function visible(el) { return el.isConnected && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; }
function descriptor(el) {
  const context = el.closest('[data-media-id], [data-media-type], [data-video-src]');
  return { tag: el.tagName.toLowerCase(), src: el.currentSrc || el.getAttribute('src') || el.querySelector('source')?.src || '',
    poster: el.poster || '', videoSrc: el.dataset.videoSrc || context?.dataset.videoSrc,
    mediaId: el.dataset.mediaId || context?.dataset.mediaId, type: el.dataset.mediaType || context?.dataset.mediaType,
    cover: !!el.closest('.thumb'), title: el.dataset.mediaTitle || el.alt || context?.dataset.mediaTitle || '' };
}

// UI contract for other pages (no changes to Thumbnail/ContentPage required):
// data-media-type="video" + data-video-src="https://... / fengsha-media://..."
// or data-media-id matching snapshot.media[].id on the image/card.
// data-media-group="name" on a container enables visible sibling navigation.
// data-media-preview="off" explicitly opts a media/control out.
export default function MediaPreview({ media = [] }) {
  const [selection, setSelection] = useState(null);
  const mediaRef = useRef(media), opener = useRef(null);
  mediaRef.current = media;
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    let stopped = false;
    const buttons = new Map(), attributes = new Map();
    function eligible(el) { return el && root.contains(el) && visible(el) && !el.closest(`${layerSelector}, [data-media-preview="off"]`); }
    function open(el, trigger = el) {
      if (!eligible(el)) return;
      const group = el.closest('[data-media-group]');
      const items = group ? [...group.querySelectorAll('img, video')].filter(eligible) : [el];
      opener.current = trigger;
      setSelection({ items, index: Math.max(0, items.indexOf(el)) });
    }
    function click(event) {
      const el = event.target.closest?.('img, video, [data-media-preview-trigger]');
      // All interactions with native controls, including seek/volume/play, pass through.
      if (!eligible(el) || el.tagName === 'VIDEO' && el.controls || event.button !== 0) return;
      event.preventDefault(); event.stopImmediatePropagation(); open(el);
    }
    function key(event) {
      const el = event.target;
      if (!eligible(el) || !el.matches('img, video:not([controls])') || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation(); open(el);
    }
    function enhance() {
      if (stopped) return;
      for (const el of attributes.keys()) if (!root.contains(el)) attributes.delete(el);
      for (const [video, button] of buttons) if (!root.contains(video) || !video.controls || video.closest('[data-media-preview="off"]')) { button.remove(); buttons.delete(video); }
      for (const el of root.querySelectorAll('img, video')) {
        if (el.closest('[data-media-preview="off"]')) continue;
        if (el.tagName === 'VIDEO' && el.controls) {
          if (buttons.has(el) && !buttons.get(el).isConnected) el.after(buttons.get(el));
          if (!buttons.has(el)) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'media-preview-open-video'; button.textContent = '放大视频'; button.setAttribute('aria-label', '放大视频');
            button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(el, button); });
            el.after(button); buttons.set(el, button);
          }
          continue;
        }
        if (!attributes.has(el)) {
          const old = Object.fromEntries(['tabindex', 'role', 'aria-label', 'data-media-preview-ready'].map(k => [k, el.getAttribute(k)]));
          attributes.set(el, old);
          if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
          if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
          if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', `放大查看${el.alt || (el.tagName === 'VIDEO' ? '视频' : '图片')}`);
          el.setAttribute('data-media-preview-ready', 'true');
        }
      }
    }
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    const observer = new MutationObserver(enhance);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['controls', 'data-media-preview'] });
    enhance();
    return () => {
      stopped = true; observer.disconnect();
      document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true);
      for (const button of buttons.values()) button.remove();
      for (const [el, old] of attributes) for (const [key, value] of Object.entries(old)) value === null ? el.removeAttribute(key) : el.setAttribute(key, value);
    };
  }, []);
  if (!selection) return null;
  const element = selection.items[selection.index];
  const item = resolveMedia(descriptor(element), mediaRef.current);
  const change = step => setSelection(s => ({ ...s, index: (s.index + step + s.items.length) % s.items.length }));
  return createPortal(<PreviewDialog item={item} element={element} count={selection.items.length} index={selection.index}
    change={change} close={() => setSelection(null)} opener={opener}/>, document.body);
}

function PreviewDialog({ item, element, count, index, change, close, opener }) {
  const dialog = useRef(null), closeButton = useRef(null), player = useRef(null), closeRef = useRef(close), changeRef = useRef(change);
  const [zoom, setZoom] = useState(1), [size, setSize] = useState(null), [retry, setRetry] = useState(0), [error, setError] = useState(item.error || ''), [loading, setLoading] = useState(!!item.src), [playback, setPlayback] = useState('');
  closeRef.current = close; changeRef.current = change;
  useEffect(() => {
    const active = document.activeElement, body = document.body;
    const oldOverflow = body.style.overflow, oldPadding = body.style.paddingRight;
    const scrollGap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollGap > 0) body.style.paddingRight = `${scrollGap + parseFloat(getComputedStyle(body).paddingRight || 0)}px`;
    const root = document.getElementById('root'), wasInert = root?.inert;
    if (root) root.inert = true;
    closeButton.current.focus();
    function key(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
      else if (event.key === 'Tab') {
        const nodes = [...dialog.current.querySelectorAll(focusable)].filter(visible);
        const current = nodes.indexOf(document.activeElement);
        event.preventDefault(); event.stopImmediatePropagation();
        nodes[(current + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus();
      } else if (count > 1 && ['ArrowLeft', 'ArrowRight'].includes(event.key) && document.activeElement?.tagName !== 'VIDEO') {
        event.preventDefault(); event.stopImmediatePropagation(); changeRef.current(event.key === 'ArrowRight' ? 1 : -1);
      }
    }
    function focus(event) { if (!dialog.current.contains(event.target)) closeButton.current?.focus(); }
    document.addEventListener('keydown', key, true); document.addEventListener('focusin', focus, true);
    return () => {
      document.removeEventListener('keydown', key, true); document.removeEventListener('focusin', focus, true);
      body.style.overflow = oldOverflow; body.style.paddingRight = oldPadding;
      if (root) root.inert = wasInert;
      const target = opener.current?.isConnected ? opener.current : active;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [count, opener]);
  useEffect(() => {
    setZoom(1); setSize(null); setError(item.error || ''); setLoading(!!item.src); setPlayback('');
    const video = player.current, original = element.tagName === 'VIDEO' ? element : null;
    const previous = original ? { paused: original.paused, time: original.currentTime, volume: original.volume, muted: original.muted, rate: original.playbackRate } : null;
    if (item.kind === 'video') {
      original?.pause();
      if (video && previous) { video.volume = previous.volume; video.muted = previous.muted; video.playbackRate = previous.rate; }
    }
    let ended = false;
    const loaded = () => {
      setLoading(false);
      if (previous && Number.isFinite(previous.time)) video.currentTime = previous.time;
      // Only the known source is played; no download/model/export action is invoked.
      video?.play().catch(() => { if (!ended) setPlayback('自动播放未开始，请使用播放控件。'); });
    };
    video?.addEventListener('loadedmetadata', loaded);
    return () => {
      ended = true; video?.removeEventListener('loadedmetadata', loaded);
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      if (original?.isConnected && previous && item.kind === 'video') {
        original.currentTime = previous.time;
        if (!previous.paused) original.play().catch(() => {});
      }
    };
  }, [item.kind, item.src, item.error, element, retry]);
  // Stop the timeout when any successful frame/image arrives.
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => { setLoading(false); setError('媒体加载超时，请检查本地文件或网络后重试。'); }, 15000);
    return () => clearTimeout(timer);
  }, [loading, item.src]);
  const loaded = event => {
    setLoading(false); setError('');
    if (event.currentTarget.tagName === 'IMG') {
      const image = event.currentTarget, stage = dialog.current.querySelector('.media-preview-stage');
      const fit = Math.min(stage.clientWidth / image.naturalWidth, window.innerHeight * .68 / image.naturalHeight);
      setSize({ width: image.naturalWidth * fit, height: image.naturalHeight * fit });
    }
  };
  return <div className="media-preview-layer" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="media-preview-dialog" role="dialog" aria-modal="true" aria-label="媒体放大预览" ref={dialog}>
      <header className="media-preview-toolbar"><strong>{item.title}</strong><span>{count > 1 ? `${index + 1} / ${count}` : item.kind === 'video' ? '视频' : '图片'}</span>
        {item.kind === 'image' && <div className="media-preview-zoom"><button type="button" aria-label="缩小图片" disabled={zoom <= 0.25} onClick={() => setZoom(v => zoomLevel(v, '-'))}>−</button><button type="button" aria-label="重置图片缩放" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="放大图片" disabled={zoom >= 4} onClick={() => setZoom(v => zoomLevel(v, '+'))}>＋</button></div>}
        <button type="button" aria-label="关闭媒体预览" ref={closeButton} onClick={close}>✕</button></header>
      {item.notice && <p className="media-preview-notice" role="status">{item.notice}</p>}
      <div className="media-preview-stage">
        {loading && <p className="media-preview-loading" role="status">正在加载媒体…</p>}
        {error && <div className="media-preview-error" role="alert">{error}{item.src && <button type="button" onClick={() => setRetry(v => v + 1)}>重试加载</button>}</div>}
        {item.src && (item.kind === 'video' ? <video key={`${item.src}-${retry}`} ref={player} controls playsInline preload="metadata" src={item.src} poster={item.poster || undefined} onLoadedData={loaded} onError={() => { setLoading(false); setError('视频加载失败，文件可能缺失、地址已过期或格式不受支持。'); }}/>
          : <div className="media-preview-image-scroll"><img key={`${item.src}-${retry}`} src={item.src} alt={item.title} referrerPolicy="no-referrer" style={size ? { width: size.width * zoom, height: size.height * zoom } : undefined} onLoad={loaded} onError={() => { setLoading(false); setError('图片加载失败，请检查文件或图片地址。'); }}/></div>)}
      </div>
      <footer className="media-preview-footer">{count > 1 && <><button type="button" aria-label="上一张媒体" onClick={() => change(-1)}>← 上一张</button><button type="button" aria-label="下一张媒体" onClick={() => change(1)}>下一张 →</button></>}<span>{playback || 'Esc 或点击背景关闭'}</span></footer>
    </section>
  </div>;
}
