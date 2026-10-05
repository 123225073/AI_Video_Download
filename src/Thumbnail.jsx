import React, { useState } from 'react';
import { FileVideo } from 'lucide-react';
import { thumbnailUrl } from '../electron/thumbnail.js';

export default function Thumb({ item, className = '' }) {
  const [failed, setFailed] = useState('');
  const src = thumbnailUrl(item.thumbnail);
  return <div className={`thumb ${className}`} title={src && src === failed ? '封面暂时无法加载，视频信息与下载不受影响' : undefined}>
    {src && src !== failed ? <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(src)}/> : null}
    <FileVideo className="thumb-placeholder" size={32}/>
    {item.duration ? <span className="duration">{item.duration >= 3600 ? `${Math.floor(item.duration / 3600)}:` : ''}{item.duration >= 3600 ? String(Math.floor(item.duration % 3600 / 60)).padStart(2, '0') : Math.floor(item.duration / 60)}:{String(Math.floor(item.duration % 60)).padStart(2, '0')}</span> : null}
  </div>;
}
