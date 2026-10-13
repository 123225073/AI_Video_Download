import React, { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useRef, useState } from 'react';
import { safeMediaUrl, videoPlaybackError } from './media-preview.js';
import './media-preview.css';

// Keep this component mounted outside editor tab conditionals. Pass only the
// stable original preview URL; do not key it by draft revision or AI job status.
// ref is the native HTMLVideoElement, compatible with existing MediaPreview.
const VideoPlayer = forwardRef(function VideoPlayer({ src, label = '原视频播放', title = '原视频', className = '', onError, onLoadedMetadata, onLoadedData, onPlaying, ...props }, ref) {
  const source = safeMediaUrl(src, 'video'), player = useRef(null), probe = useRef(null), lastTime = useRef(0), retryTime = useRef(null);
  const retrySequence = useRef(0);
  const [retryRequest, setRetryRequest] = useState(null);
  const playbackSource = retryRequest?.source === source ? retryRequest.url : source;
  const [error, setError] = useState('');
  useImperativeHandle(ref, () => player.current, [source]);
  useEffect(() => {
    setError(source ? '' : '没有可播放的视频地址。'); lastTime.current = 0; retryTime.current = null;
    return () => probe.current?.abort();
  }, [source]);
  useLayoutEffect(() => { if (retryRequest?.source === source) player.current?.load(); }, [retryRequest, source]);
  const clearError = () => { probe.current?.abort(); setError(''); };
  async function failed(event) {
    const video = event.currentTarget, mediaError = video.error, local = source.startsWith('fengsha-media:');
    onError?.(event);
    probe.current?.abort();
    const controller = new AbortController(); probe.current = controller;
    setError(videoPlaybackError(mediaError, { local }));
    if (local) {
      try {
        const response = await fetch(source, { headers: { Range: 'bytes=0-0' }, signal: controller.signal });
        await response.body?.cancel();
        if (!controller.signal.aborted && player.current === video) setError(videoPlaybackError(mediaError, { local, status: response.status }));
      } catch { /* Retain the media error if the diagnostic read also fails. */ }
    }
  }
  function retry() {
    probe.current?.abort(); setError('');
    retryTime.current = lastTime.current;
    const video = player.current;
    if (video) {
      // Chromium retains failed custom-protocol media even after load()/remount.
      // Only an explicit local retry refreshes that resource key; the protocol
      // ignores this query and reads the SAME local file, without any download.
      if (source.startsWith('fengsha-media:')) {
        const url = new URL(source); url.searchParams.set('__fengsha_retry', String(++retrySequence.current));
        setRetryRequest({ source, url: url.href });
      } else video.load();
    }
  }
  return <div className={`video-player ${className}`}>
    <video {...props} ref={player} src={playbackSource || undefined} controls={props.controls ?? true} playsInline={props.playsInline ?? true} preload={props.preload ?? 'metadata'}
      aria-label={props['aria-label'] || label} data-media-title={title}
      onTimeUpdate={event => { if (!event.currentTarget.error) lastTime.current = event.currentTarget.currentTime; props.onTimeUpdate?.(event); }}
      onLoadedMetadata={event => {
        clearError();
        if (retryTime.current !== null) { const time = retryTime.current; retryTime.current = null; if (time > 0 && time < event.currentTarget.duration) event.currentTarget.currentTime = time; }
        onLoadedMetadata?.(event);
      }} onLoadedData={event => { clearError(); onLoadedData?.(event); }} onPlaying={event => { clearError(); onPlaying?.(event); }} onError={failed}/>
    {error && <div className="video-player-error" role="alert"><span>{error}</span>{source && <button type="button" onClick={retry}>重试加载</button>}</div>}
  </div>;
});
export default VideoPlayer;
