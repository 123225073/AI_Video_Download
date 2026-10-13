import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import VideoStylePicker from './VideoStylePicker.jsx';
import './VideoArticleOptions.css';

const PAGE_COUNTS = ['3', '4', '5', '6', '8', '10'];

export default function VideoArticleOptions({ value, onApply, onClose, disabled = false, currentReferenceDisabled = false }) {
  const id = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [draft, setDraft] = useState(() => ({
    reference: value?.reference === 'current' && !currentReferenceDisabled ? 'current' : 'corrected',
    pageCount: String(value?.pageCount ?? 'auto'),
    style: value?.style ?? 'auto',
    customStyle: value?.customStyle ?? '',
    generateImages: value?.generateImages ?? false,
    outputLanguage: value?.outputLanguage ?? 'source',
  }));

  useLayoutEffect(() => {
    const previousFocus = document.activeElement;
    const body = document.body;
    const previousOverflow = body.style.getPropertyValue('overflow');
    const previousPriority = body.style.getPropertyPriority('overflow');
    body.style.setProperty('overflow', 'hidden');

    function focusableElements() {
      return Array.from(dialogRef.current?.querySelectorAll(
        'button, input, select, textarea, a[href], [tabindex]',
      ) ?? []).filter(element => element.tabIndex >= 0 && !element.disabled
        && !element.closest('[inert]') && element.getClientRects().length > 0
        && window.getComputedStyle(element).visibility !== 'hidden');
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (!first) {
        event.preventDefault();
        dialogRef.current?.focus({ preventScroll: true });
      } else if (!elements.includes(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    }

    function containFocus(event) {
      if (!dialogRef.current?.contains(event.target)) {
        closeRef.current?.focus({ preventScroll: true });
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', containFocus);
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', containFocus);
      if (previousOverflow) body.style.setProperty('overflow', previousOverflow, previousPriority);
      else body.style.removeProperty('overflow');
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    };
  }, []);

  function update(field, nextValue) {
    if (disabled || (field === 'reference' && nextValue === 'current' && currentReferenceDisabled)) return;
    setDraft(previous => ({ ...previous, [field]: nextValue }));
  }

  const unavailableReference = draft.reference === 'current' && currentReferenceDisabled;
  const missingCustomStyle = draft.style === 'custom' && !draft.customStyle.trim();
  const applyDisabled = disabled || unavailableReference || missingCustomStyle;

  function apply(event) {
    event.preventDefault();
    if (!applyDisabled) onApply?.({ ...draft });
  }

  return createPortal(
    <div className="video-article-settings-backdrop" onClick={event => {
      if (event.target === event.currentTarget) onClose?.();
    }}>
      <section
        ref={dialogRef}
        className="video-article-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-intro`}
        tabIndex={-1}
        data-media-preview="off"
      >
        <header className="video-article-settings__header">
          <div>
            <h2 id={`${id}-title`}>创作设置</h2>
            <p id={`${id}-intro`}>设置图文的创作依据、页数、画风与输出语言。</p>
          </div>
          <button ref={closeRef} type="button" className="video-article-settings__close" aria-label="关闭创作设置" onClick={() => onClose?.()}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <form className="video-article-settings__form" onSubmit={apply}>
          <div className="video-article-settings__body">
            {disabled && <p className="video-article-settings__notice" role="status">正在处理任务或有未保存文案，暂时无法修改或应用设置，仍可取消或关闭。</p>}
            <div className="video-article-settings__fields">
              <label className="video-article-settings__field">
                <span>创作依据</span>
                <select aria-label="图文创作依据" value={draft.reference} disabled={disabled} onChange={event => update('reference', event.target.value)} aria-describedby={currentReferenceDisabled ? `${id}-reference-hint` : undefined}>
                  <option value="corrected">AI 校对稿（默认）</option>
                  <option value="current" disabled={currentReferenceDisabled}>基于校对稿的当前二创稿</option>
                </select>
                {currentReferenceDisabled && <small id={`${id}-reference-hint`}>当前文案已过期，请使用校对稿。</small>}
              </label>
              <label className="video-article-settings__field">
                <span>图文页数</span>
                <select aria-label="图文页数" value={draft.pageCount} disabled={disabled} onChange={event => update('pageCount', event.target.value)}>
                  <option value="auto">按内容规划</option>
                  {PAGE_COUNTS.map(count => <option key={count} value={count}>{count} 页</option>)}
                </select>
              </label>
            </div>
            <VideoStylePicker value={draft.style} onChange={next => update('style', next)} disabled={disabled} />
            {draft.style === 'custom' && <label className="video-article-settings__field video-article-settings__custom">
              <span>自定义画风</span>
              <textarea aria-label="自定义图文画风" rows={2} value={draft.customStyle} disabled={disabled} required onChange={event => update('customStyle', event.target.value)} placeholder="例如：黑白钢笔插画，少量暖黄色强调" aria-describedby={`${id}-custom-hint`} />
              <small id={`${id}-custom-hint`}>请填写整组配图使用的画风描述。</small>
            </label>}
            <label className="video-article-settings__field video-article-settings__language">
              <span>输出语言</span>
              <select aria-label="图文输出语言" value={draft.outputLanguage} disabled={disabled} onChange={event => update('outputLanguage', event.target.value)} aria-describedby={`${id}-language-hint`}>
                <option value="source">源语言（默认）</option>
                <option value="chinese">中文</option>
              </select>
              <small id={`${id}-language-hint`}>创作方向可以用中文输入；若希望图文以中文输出，请选择“中文”。默认保持源语言。</small>
            </label>
            <label className="video-article-settings__images">
              <input type="checkbox" aria-label="生成图文配图" checked={draft.generateImages} disabled={disabled} onChange={event => update('generateImages', event.target.checked)} aria-describedby={`${id}-images-hint`} />
              <span>
                <strong>同时生成配图</strong>
                <small id={`${id}-images-hint`}>默认关闭。开启后会调用已配置的图片模型，可能产生费用。</small>
              </span>
            </label>
          </div>
          <footer className="video-article-settings__footer">
            <button type="button" className="video-article-settings__button" onClick={() => onClose?.()}>取消</button>
            <button type="submit" className="video-article-settings__button video-article-settings__button--primary" disabled={applyDisabled}>确认应用</button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
