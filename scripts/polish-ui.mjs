import fs from 'node:fs';
const file = 'src/TranscriptionPage.jsx'; let s = fs.readFileSync(file, 'utf8');
function replace(from, to) { if (!s.includes(from)) throw new Error('UI anchor missing'); s = s.replace(from, to); }
replace('>AI 摘要</button><button className={tab', '>{record.archivedAt ? "确认摘要" : dirty ? "摘要审阅稿" : "AI 摘要"}</button>{record.summary && (dirty || record.archivedAt) && <button className={tab === "original-summary" ? "selected" : ""} onClick={() => setTab("original-summary")}>AI 初稿</button>}<button className={tab');
replace('<pre className="readable-text">{text ||', '<ReadingText plain={tab === "transcript"} text={text ||');
replace(" : '文稿尚未生成。')}</pre>", " : '文稿尚未生成。')} />");
replace('原始文稿保留。以下内容作为你的确认稿保存，可随时补充和修改。', '原始文稿保留。编辑草稿自动保存在本机，确认后进入知识归档。');
replace('有未保存的编辑', '审阅草稿已自动保存，待确认归档');
replace('placeholder="搜索标题、作者、标签"', 'placeholder={archiveView ? "搜索标题、标签、摘要、原文和笔记" : "搜索标题、作者、标签"}');
fs.writeFileSync(file, s);
