import React from 'react';

function inline(text) { return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part); }
// Render a small Markdown subset as escaped React text; never execute model HTML.
export default function ReadingText({ text, plain = false }) {
  if (plain) return <pre className="readable-text">{text}</pre>;
  const blocks = [], lines = String(text || '').split('\n'); let paragraph = [], list = [], ordered = false, code = null;
  const flushParagraph = () => { if (paragraph.length) { blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '))}</p>); paragraph = []; } };
  const flushList = () => { if (list.length) { const Tag = ordered ? 'ol' : 'ul'; blocks.push(<Tag key={blocks.length}>{list.map((x, i) => <li key={i}>{inline(x)}</li>)}</Tag>); list = []; } };
  for (const line of lines) {
    if (line.startsWith('```')) { flushParagraph(); flushList(); if (code === null) code = []; else { blocks.push(<pre key={blocks.length}>{code.join('\n')}</pre>); code = null; } continue; }
    if (code !== null) { code.push(line); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/), item = line.match(/^\s*(?:([-*])|\d+[.)])\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); const Tag = `h${Math.min(4, heading[1].length + 1)}`; blocks.push(<Tag key={blocks.length}>{inline(heading[2])}</Tag>); }
    else if (item) { flushParagraph(); const nextOrdered = !item[1]; if (list.length && ordered !== nextOrdered) flushList(); ordered = nextOrdered; list.push(item[2]); }
    else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList(); if (code !== null) blocks.push(<pre key={blocks.length}>{code.join('\n')}</pre>);
  return <div className="readable-text markdown-reading">{blocks}</div>;
}
