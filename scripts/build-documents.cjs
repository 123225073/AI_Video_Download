const fs = require('fs');
const path = require('path');
const runtime = process.env.FENGSHA_DOCUMENT_MODULES || 'C:/Users/CM1165/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, HeadingLevel, WidthType, Header, Footer, AlignmentType, PageNumber, ExternalHyperlink, BorderStyle } = require(path.join(runtime, 'docx'));
const sharp = require(path.join(runtime, 'sharp'));
const directory = path.resolve('docs/设计交付-2026-09-30');
const specs = [
  ['01-新建下载.png', '新建下载', '粘贴链接、识别平台、预览结果；识别完成后由用户选择内容。'],
  ['02-内容选择.png', '内容选择', '按条目勾选、设置画质与目录、确认批量数量。'],
  ['03-任务中心.png', '任务中心', '真实进度、合并校验、暂停与重试；明确说明失败原因。'],
  ['04-媒体库.png', '媒体库', '平台、作者、合集和时间组合检索，播放与定位本地视频。'],
  ['05-设置.png', '设置', '默认下载目录、并发、有限重试、归档与组件检查。'],
  ['06-账号管理.png', '账号管理', '独立账号登录、会话保留、失效提示、用户选择会话文件导入。']
];
const clean = s => s.replace(/`/g, '').replace(/\*\*/g, '');
function runs(text) {
  const children = []; const re = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g; let last = 0, match;
  while ((match = re.exec(text))) { if (match.index > last) children.push(new TextRun(clean(text.slice(last, match.index)))); children.push(new ExternalHyperlink({ link: match[2], children: [new TextRun({ text: match[1], style: 'Hyperlink' })] })); last = re.lastIndex; }
  if (last < text.length) children.push(new TextRun(clean(text.slice(last)))); return children;
}
function markdown(source) {
  const lines = source.split(/\r?\n/), result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    if (line.startsWith('|')) {
      const rows = []; while (i < lines.length && lines[i].trim().startsWith('|')) { const row = lines[i].trim().split('|').slice(1, -1).map(s => s.trim()); if (!row.every(s => /^:?-+:?$/.test(s))) rows.push(row); i++; } i--;
      const columns = rows[0].length, width = 9360, colWidths = Array(columns).fill(Math.floor(width / columns)); colWidths[columns - 1] += width - colWidths.reduce((a, b) => a + b, 0);
      result.push(new Table({ width: { size: width, type: WidthType.DXA }, columnWidths: colWidths, rows: rows.map((row, rowIndex) => new TableRow({ tableHeader: rowIndex === 0, children: row.map((text, index) => new TableCell({ width: { size: colWidths[index], type: WidthType.DXA }, margins: { top: 100, bottom: 100, left: 100, right: 100 }, shading: { fill: rowIndex === 0 ? 'EAF2FF' : rowIndex % 2 ? 'FFFFFF' : 'F7F9FC' }, children: [new Paragraph({ spacing: { after: 60 }, children: runs(text).map(run => run) })] })) })) }));
      result.push(new Paragraph({ text: '', spacing: { after: 120 } })); continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)/);
    if (heading) result.push(new Paragraph({ heading: heading[1].length === 1 ? HeadingLevel.TITLE : heading[1].length === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, children: runs(heading[2]), spacing: { before: 260, after: 160 }, keepNext: true }));
    else result.push(new Paragraph({ ...(line.startsWith('- ') ? { bullet: { level: 0 } } : {}), children: runs(line.replace(/^- /, '')), spacing: { after: 130, line: 320 } }));
  }
  return result;
}
(async () => {
  const children = markdown(fs.readFileSync(path.join(directory, '需求功能说明书.md'), 'utf8'));
  if (fs.existsSync(path.join(directory, '首版验收报告.md'))) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: '首版本机验收结果', pageBreakBefore: true }), ...markdown(fs.readFileSync(path.join(directory, '首版验收报告.md'), 'utf8')));
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: '附录：六个页面的设计稿', pageBreakBefore: true }));
  for (let i = 0; i < specs.length; i++) {
    const [file, title, description] = specs[i], data = fs.readFileSync(path.join(directory, file)), info = await sharp(data).metadata();
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: `${i + 1}. ${title}`, pageBreakBefore: i > 0, keepNext: true }), new Paragraph({ text: description, spacing: { after: 180 }, keepNext: true }), new Paragraph({ children: [new ImageRun({ type: 'png', data, transformation: { width: 624, height: Math.round(624 * info.height / info.width) } })] }), new Paragraph({ text: '图中封面、数量与平台状态为设计示例。实际支持范围以验收报告为准。', spacing: { before: 140 } }));
  }
  const doc = new Document({ title: '风沙全平台视频下载器需求与设计说明书', creator: '风沙', description: '六页设计、功能需求、账号管理、架构与真实验收', styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 20, color: '253653' } } }, paragraphStyles: [ { id: 'Title', name: 'Title', basedOn: 'Normal', run: { size: 36, bold: true, color: '1C4485' } }, { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', run: { size: 28, bold: true, color: '1C4485' } }, { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', run: { size: 24, bold: true, color: '2877FA' } } ] }, sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 } } }, headers: { default: new Header({ children: [new Paragraph({ text: '风沙全平台视频下载器 · V0.1 · 2026-09-30', border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E0E8F5' } }, spacing: { after: 120 } })] }) }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('第 '), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(' 页')] })] }) }, children }] });
  const target = path.join(directory, '风沙全平台视频下载器-需求与设计说明书.docx'); fs.writeFileSync(target, await Packer.toBuffer(doc));
  const esc = x => x.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>风沙下载器设计交付</title><style>body{margin:0;background:#f6f9fe;color:#18314f;font-family:'Microsoft YaHei',sans-serif}header,main{max-width:1200px;margin:auto;padding:32px}header{padding-bottom:8px}h1{margin:0 0 12px;font-size:30px}p{color:#68809c;line-height:1.8}nav{display:flex;gap:12px;flex-wrap:wrap}a{color:#216ff2}article{background:white;padding:24px;margin:24px 0;border:1px solid #e1e9f5;border-radius:12px;box-shadow:0 8px 30px #1e4a8410}h2{margin:0 0 8px}img{width:100%;display:block;border-radius:8px;margin-top:20px}small{color:#7289a2}</style><header><h1>风沙全平台视频下载器</h1><p>六个独立页面的设计稿与功能说明 · 2026-09-30</p><nav><a href="风沙全平台视频下载器-需求与设计说明书.docx">下载 Word 说明书</a><a href="需求功能说明书.md">完整需求</a><a href="首版验收报告.md">真实验收结果</a></nav><p>设计中的视频封面、数量和状态是示例。账号管理已纳入开发；平台支持以实测结果为准。</p></header><main>${specs.map(([file, title, desc]) => `<article><h2>${esc(title)}</h2><p>${esc(desc)}</p><a href="${encodeURIComponent(file)}"><img src="${encodeURIComponent(file)}" alt="${esc(title)}设计稿"></a></article>`).join('')}</main></html>`;
  fs.writeFileSync(path.join(directory, '设计稿与说明.html'), html); console.log(target);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
