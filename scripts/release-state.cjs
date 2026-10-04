// Read only metadata and hashes. Do not export cookies, session values or credentials.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const initSqlJs = require('sql.js');
(async () => {
  const directory = process.argv[3] || path.join(process.env.APPDATA, 'fengsha-video-downloader'), file = path.join(directory, 'library.sqlite');
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const bytes = fs.readFileSync(file), db = new SQL.Database(bytes);
  const records = kind => { const s = db.prepare('SELECT data FROM records WHERE kind=?'); const rows = []; try { s.bind([kind]); while (s.step()) rows.push(JSON.parse(s.getAsObject().data)); } finally { s.free(); } return rows; };
  const accounts = records('account').map(({ id, platform, name, status, lastSync }) => ({ id, platform, name, status, lastSync }));
  const settings = records('settings'), tasks = records('task'), media = records('media');
  const sessions = accounts.map(a => { const f = path.join(directory, 'accounts', 'sessions', a.id, 'session.encrypted'); return { id: a.id, exists: fs.existsSync(f), hash: fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null }; });
  const transcriptions = records('transcription');
  const hashRecords = kind => crypto.createHash('sha256').update(JSON.stringify(records(kind).sort((a,b)=>String(a.id || a.title || '').localeCompare(String(b.id || b.title || ''))))).digest('hex');
  const encryptedAI = ['text','speech'].map(kind => { const file = path.join(directory,'ai',`ai-${kind}.encrypted`); return { kind, exists: fs.existsSync(file), hash: fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null }; });
  const report = { databaseHash: crypto.createHash('sha256').update(bytes).digest('hex'), accounts, activeAccounts: records('active-account'), settings, taskIds: tasks.map(t => t.id).sort(), mediaIds: media.map(m => m.id).sort(), activeDownloads: tasks.filter(t => ['downloading', 'processing'].includes(t.status)).length, sessions, transcriptionCount: transcriptions.length, activeTranscriptions: transcriptions.filter(t=>['queued','preparing','subtitles','transcribing','correcting','summarizing','translating'].includes(t.status)).length, transcriptionHash: hashRecords('transcription'), draftHash: hashRecords('transcription-draft'), aiConfigHash: hashRecords('ai-config'), encryptedAI };
  db.close();
  const destination = process.argv[2]; if (destination) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ destination, databaseHash: report.databaseHash, accounts: accounts.map(a => ({ platform: a.platform, status: a.status })), tasks: tasks.length, media: media.length, activeDownloads: report.activeDownloads, transcriptions: report.transcriptionCount, activeTranscriptions: report.activeTranscriptions, encryptedSessions: sessions.filter(s => s.exists).length }, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
