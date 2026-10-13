import React, { useId } from 'react';
import { VIDEO_STYLES, VIDEO_STYLE_OPTIONS } from './video-styles.js';
import './video-style-picker.css';

export default function VideoStylePicker({ value = 'auto', onChange, disabled = false }) {
  const headingId = useId();
  const hintId = useId();
  const modes = VIDEO_STYLE_OPTIONS.filter(option => !option.preview);

  function select(id) {
    if (!disabled) onChange?.(id);
  }

  return (
    <section className="video-style-picker" aria-labelledby={headingId} data-media-preview="off">
      <div className="video-style-picker__heading">
        <b id={headingId}>配图风格</b>
        <span id={hintId}>8 种画风 · 点击示例选择</span>
      </div>
      <div className="video-style-picker__modes" role="group" aria-label="自动与自定义风格">
        {modes.map(option => (
          <button
            key={option.id}
            type="button"
            className="video-style-picker__mode"
            aria-label={option.label}
            aria-describedby={`${headingId}-${option.id}`}
            aria-pressed={value === option.id}
            disabled={disabled}
            onClick={() => select(option.id)}
          >
            <span className="video-style-picker__mode-title">
              <strong>{option.label}</strong>
              {value === option.id && <span className="video-style-picker__selected">✓ 已选</span>}
            </span>
            <span className="video-style-picker__description" id={`${headingId}-${option.id}`}>{option.description}</span>
          </button>
        ))}
      </div>
      <div className="video-style-picker__grid" role="group" aria-label="固定配图风格" aria-describedby={hintId}>
        {VIDEO_STYLES.map(style => (
          <button
            key={style.id}
            type="button"
            className="video-style-picker__card"
            aria-label={style.label}
            aria-describedby={`${headingId}-${style.id}`}
            aria-pressed={value === style.id}
            disabled={disabled}
            onClick={() => select(style.id)}
          >
            <span className="video-style-picker__preview">
              <img src={style.preview} alt={`${style.label}画风示例`} loading="lazy" decoding="async" />
              {value === style.id && <span className="video-style-picker__selected">✓ 已选</span>}
            </span>
            <span className="video-style-picker__copy">
              <strong>{style.label}</strong>
              <span className="video-style-picker__description" id={`${headingId}-${style.id}`}>{style.description}</span>
              <span className="video-style-picker__suitable">适合：{style.suitableFor}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
