import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, protocol, net, safeStorage } from 'electron';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { Queue } from './queue.js';
import { AccountManager } from './accounts.js';
import { WeChat } from './wechat.js';
import { Creators } from './creators.js';
import { CreatorBrowser } from './creator-browser.js';
import { concurrencySetting } from './scheduler.js';
import { linksFromText, platformOf, classifyError, safeLog } from './core.js';
import { AIService } from './ai.js';
import { Transcriptions, transcriptionUrl } from './transcription.js';
import { WeChatCreators } from './wechat-creators.js';
import { CollectorConnection } from './collector-connection.js';
import { createAgentHandler, startAgentServer } from './agent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep mutable data outside the program directory so future installer updates cannot remove it.
const localBase = app.isPackaged ? path.resolve(path.dirname(app.getPath('exe')), '..') : path.join(root, '.local');
const testMode = process.env.FENGSHA_TEST_MODE === '1' && !app.isPackaged;
const background = process.argv.includes('--agent-background');
const dataArg = process.argv.indexOf('--agent-data-dir');
if (testMode) console.error('FENGSHA_BOOT: module');
if (dataArg >= 0 && process.argv[dataArg + 1]) app.setPath('userData', path.resolve(process.argv[dataArg + 1]));
else if (testMode && process.env.FENGSHA_TEST_DATA) app.setPath('userData', path.resolve(process.env.FENGSHA_TEST_DATA));
else app.setPath('userData', path.join(localBase, '用户数据'));
protocol.registerSchemesAsPrivileged([{ scheme: 'fengsha-media', privileges: { secure: true, stream: true, supportFetchAPI: true } }]);
let win, store, queue, accounts, engine, creators, ai, transcriptions, wechatCreators, collectorConnection, environment = [], parseProgress = null, closing = false, quitting = false;
let agentServer, agentIdleTimer;
const snapshot = () => ({ version: app.getVersion(), settings: store.settings(), tasks: queue.tasks(), media: queue.media().map(m => ({ ...m, exists: fs.existsSync(m.filePath) })), accounts: accounts.list(), environment, parseProgress, creatorProgress: creators?.progress(), scheduler: queue.scheduler(), ai: ai?.all(), transcriptions: transcriptions?.list() || [], transcriptionFolders: transcriptions?.folders() || [], speechEnvironment: transcriptions?.environment(), collector: wechatCreators?.config(), collectorConnection:collectorConnection?.status() });
let changedTimer;
function changed() { clearTimeout(changedTimer); if (closing || quitting) return; changedTimer = setTimeout(() => { if (!closing && !quitting && win && !win.isDestroyed()) win.webContents.send('fengsha:changed', snapshot()); }, 80); }
function handle(name, callback) { ipcMain.handle(`fengsha:${name}`, async (event, ...args) => { if (event.sender !== win.webContents) return { ok: false, error: '无效请求' }; try { return { ok: true, value: await callback(...args) }; } catch (e) { return { ok: false, error: classifyError(e.message).category === 'unknown' ? safeLog(e.message) : classifyError(e.message).message }; } }); }
function mediaById(id) { const m = store.get('media', id); if (!m) throw new Error('媒体记录不存在'); return m; }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (!argv.includes('--agent-background') && win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  await app.whenReady();
  if (testMode) console.error('FENGSHA_BOOT: ready');
  const bin = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(root, 'bin');
  store = await Store.open(app.getPath('userData'), { savePath: path.join(localBase, '下载视频'), concurrency: 'auto', quality: 'best', retries: 3, archive: 'collection', skipDuplicates: true, autoStart: false });
  if (testMode) console.error('FENGSHA_BOOT: database');
  accounts = new AccountManager(store, path.join(app.getPath('userData'), 'accounts'), changed);
  await accounts.restore();
  const wechat = new WeChat(accounts, bin); engine = new Engine(bin, accounts, wechat); queue = new Queue(store, engine, changed);
  engine.douyinBrowser = () => new CreatorBrowser(accounts, engine);
  ai = new AIService(store, path.join(app.getPath('userData'), 'ai'), safeStorage, changed);
  transcriptions = new Transcriptions(store, engine, ai, path.join(app.getPath('userData'), '转录资料'), changed, { testing: testMode });
  wechatCreators = new WeChatCreators(store, engine);
  creators = new Creators(store, engine, new CreatorBrowser(accounts, engine), changed, wechatCreators);
  // Automatic temporary connection was explicitly requested. Certificate identity,
  // CurrentUser scope, per-task leases and recovery remain enforced by the helper.
  collectorConnection = new CollectorConnection(store,bin,path.join(app.getPath('userData'),'视频号连接'),changed,{consent:async()=>true});
  creators.connection=collectorConnection;wechat.collector=wechatCreators;wechat.connection=collectorConnection;
  if(!testMode) await collectorConnection.recover().catch(e=>collectorConnection.update('error',e.message));
  protocol.handle('fengsha-media', request => { const id = new URL(request.url).hostname; const t = id.startsWith('transcript-') ? store.get('transcription', id.slice(11)) : null; const m = t ? { filePath: t.sourceFile || t.source.file } : store.get('media', id); if (!m?.filePath || !fs.existsSync(m.filePath)) return new Response('Not found', { status: 404 }); return net.fetch(pathToFileURL(m.filePath).href); });
  handle('snapshot', snapshot);
  const parseLinks = async (text, limit = 30) => {
    if (parseProgress || creators.progress()) throw new Error('正在识别或读取博主，请等待当前操作结束');
    const urls = linksFromText(text); if (!urls.length) throw new Error('未找到链接，请粘贴平台分享链接'); if (urls.length > 30) throw new Error('一次最多识别 30 个链接');
    limit = Math.max(1, Math.min(300, Number(limit) || 30)); const results = [];
    try { for (let i = 0; i < urls.length; i++) { parseProgress = { index: i + 1, total: urls.length, platform: platformOf(urls[i]) || '未知平台' }; changed(); try { results.push(await engine.parse(urls[i], { limit })); } catch (e) { const error = classifyError(e.message); if (error.category === 'auth') accounts.markExpired(platformOf(urls[i])); results.push({ url: urls[i], platform: platformOf(urls[i]) || '未知平台', error: error.category === 'unknown' ? safeLog(e.message) : error.message, category: error.category, items: [] }); } } return results; } finally { parseProgress = null; changed(); }
  };
  handle('parse', parseLinks);
  handle('enqueue', (items, options) => queue.enqueue(items, options));
  handle('creator-identify', text => { if (parseProgress) throw new Error('正在识别视频，请等待当前识别结束'); const urls = linksFromText(text); if (urls.length !== 1) throw new Error('识别博主时请粘贴一个视频或博主主页链接'); return creators.identify(urls[0]); });
  handle('creator-page', (...args) => creators.page(...args));
  handle('creator-last', () => creators.last());
  handle('creator-cancel', () => creators.cancel());
  handle('ai-save', (kind, value) => { if (transcriptions.active) throw new Error('转录或 AI 任务正在运行，请停止或完成后再更改模型配置'); return ai.save(kind, value); });
  handle('ai-models', kind => ai.models(kind));
  handle('ai-test', () => ai.test());
  handle('transcription-choose', async () => { const r = await dialog.showOpenDialog(win, { title: '选择视频、播客、文稿或字幕', properties: ['openFile'], filters: [{ name: '音视频与文稿', extensions: ['mp4', 'mp3', 'm4a', 'wav', 'webm', 'mkv', 'mov', 'ogg', 'flac', 'aac', 'txt', 'md', 'srt', 'vtt'] }] }); return r.canceled ? null : transcriptions.choose(r.filePaths[0]); });
  handle('transcription-folder', (action, options) => transcriptions.folderAction(action, options));
  handle('transcription-start', value => transcriptions.start(value));
  handle('transcription-get', id => transcriptions.detail(id));
  handle('transcription-draft', (id, draft) => transcriptions.saveDraft(id, draft));
  handle('transcription-search', (query, all) => transcriptions.search(query, all));
  handle('transcription-source', id => { const t = transcriptions.get(id); if (t.source.url) return shell.openExternal(transcriptionUrl(t.source.url)); const file = t.sourceFile || t.source.file; if (!file || !fs.existsSync(file)) throw new Error('原文件已移动，请重新定位素材'); shell.showItemInFolder(file); });
  handle('transcription-action', (id, action, options) => transcriptions.action(id, action, options));
  handle('transcription-archive', (id, draft) => transcriptions.archive(id, draft));
  handle('transcription-unarchive', id => transcriptions.unarchive(id));
  handle('transcription-export', async (id, format, language, variant) => { if (!['md', 'txt', 'srt', 'timed-txt', 'corrected-txt', 'translation-txt', 'variant-txt', 'variant-srt', 'corrected-timed-txt', 'corrected-srt', 'corrected-candidate-txt'].includes(format)) throw new Error('请选择 Markdown、TXT 或 SRT'); const text = transcriptions.exportText(id, format, language, variant); const t = transcriptions.get(id); const extension = format.endsWith('-txt') ? 'txt' : format.endsWith('-srt') ? 'srt' : format; const suffix = { txt: '纯文本原文', 'timed-txt': '时间戳原文', 'corrected-txt': '校正文案', srt: '字幕', md: '完整资料', 'translation-txt': `译文-${language}`, 'variant-txt': `${language}-${String(variant).includes(':timed:') ? '时间戳' : '纯文本'}译文`, 'variant-srt': `${language}字幕`, 'corrected-timed-txt': '矫正时间戳文案', 'corrected-srt': '矫正字幕', 'corrected-candidate-txt': '矫正文案' }[format]; const r = await dialog.showSaveDialog(win, { title: '导出转录资料', defaultPath: path.join(store.settings().savePath, `${t.title.replace(/[<>:"/\\|?*\r\n]/g, '_').slice(0, 60)}-${suffix}.${extension}`), filters: [{ name: suffix, extensions: [extension] }] }); if (r.canceled) return null; fs.writeFileSync(r.filePath, text, 'utf8'); return { path: r.filePath }; });
  handle('collector-save', value => { if (creators.progress() || collectorConnection.status().activeTasks) throw new Error('视频号任务正在使用连接，请停止后更改连接设置'); const c = wechatCreators.save(value); changed(); return c; });
  handle('collector-test', () => wechatCreators.test());
  const connectionNotBusy=()=>{if(creators.progress() || collectorConnection.status().activeTasks)throw new Error('视频号任务正在使用连接，请停止后更改连接设置');};
  handle('collector-prepare',()=>{connectionNotBusy();return collectorConnection.prepare();});
  handle('collector-allow',()=>{connectionNotBusy();return collectorConnection.allow();});
  handle('collector-restore',()=>collectorConnection.restore());
  handle('collector-status',async()=>{let ready=false,connected=false;try{const channel=await wechatCreators.test();ready=true;connected=channel.connected;}catch{}return {...collectorConnection.status(),ready,connected};});
  const guides = { cpa: 'https://cpa.fengsha.online/', collector: 'https://ltaoo.github.io/wx_channels_download/', transcriber: 'https://github.com/wendy7756/AI-Video-Transcriber', audio: 'https://platform.openai.com/docs/guides/speech-to-text' };
  handle('guide', id => { if (!guides[id]) throw new Error('帮助页面不存在'); return shell.openExternal(guides[id]); });
  handle('action', (id, action) => queue.action(id, action));
  handle('accounts', () => accounts.list());
  handle('account-add', (platform, name) => accounts.add(platform, name));
  handle('account-import', async id => { accounts.account(id); const r = await dialog.showOpenDialog(win, { title: '导入此平台的登录会话', properties: ['openFile'], filters: [{ name: 'Netscape Cookie 文件', extensions: ['txt'] }] }); if (r.canceled) return null; return accounts.importCookies(id, r.filePaths[0]); });
  handle('login', id => accounts.login(id));
  handle('account-action', async (id, action) => { if (action === 'select') return accounts.select(id); if (action === 'complete') return accounts.complete(id); if (action === 'logout') { const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '退出该账号'], defaultId: 0, cancelId: 0, message: '退出此账号并清除本应用保存的登录会话？', detail: '账号记录和已下载视频保留。' }); if (result.response === 1) await accounts.logout(id); return; } throw new Error('未知账号操作'); });
  handle('settings', async value => {
    const old = store.settings();
    const updated = { ...old, savePath: path.resolve(String(value.savePath || old.savePath)), concurrency: concurrencySetting(value.concurrency), retries: Math.max(0, Math.min(5, Number(value.retries) || 0)), quality: ['best', '1080', '720', '480'].includes(value.quality) ? value.quality : old.quality, archive: ['flat', 'author', 'collection'].includes(value.archive) ? value.archive : old.archive, skipDuplicates: value.skipDuplicates !== false, autoStart: Boolean(value.autoStart) };
    fs.mkdirSync(updated.savePath, { recursive: true }); fs.accessSync(updated.savePath, fs.constants.W_OK);
    if (app.isPackaged && updated.autoStart !== old.autoStart) app.setLoginItemSettings({ openAtLogin: updated.autoStart });
    store.put('settings', 'main', updated); store.flush(); changed(); queue.pump(); return updated;
  });
  handle('folder', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: store.settings().savePath }); return result.canceled ? null : result.filePaths[0]; });
  handle('environment', async () => { environment = await engine.environment(); changed(); return environment; });
  handle('open-file', async id => { const m = mediaById(id); if (!fs.existsSync(m.filePath)) throw new Error('文件已移动，请重新定位'); const error = await shell.openPath(m.filePath); if (error) throw new Error(error); });
  handle('locate-file', id => { if (id) { const m = mediaById(id); if (!fs.existsSync(m.filePath)) throw new Error('文件已移动，请重新定位'); shell.showItemInFolder(m.filePath); } else return shell.openPath(store.settings().savePath); });
  handle('relocate', async id => { const m = mediaById(id); const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '视频', extensions: ['mp4', 'mkv', 'webm', 'mov'] }] }); if (r.canceled) return; const filePath = r.filePaths[0]; const info = await engine.verify(filePath); store.put('media', id, { ...m, filePath, ...info }); store.flush(); changed(); });
  handle('tags', (id, value) => { const m = mediaById(id); store.put('media', id, { ...m, tags: String(value).split(/[，,]/).map(x => x.trim().slice(0, 20)).filter(Boolean).slice(0, 12) }); changed(); });
  handle('source', async url => { if (!platformOf(url)) throw new Error('无效平台链接'); await shell.openExternal(url); });
  handle('window', action => { if (action === 'minimize') win.minimize(); if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); if (action === 'close') win.close(); });
  handle('clipboard', () => clipboard.readText());
  handle('help', () => shell.openPath(app.isPackaged ? path.join(process.resourcesPath, '使用说明.md') : path.join(root, 'docs', '使用说明.md')));
  win = new BrowserWindow({ width: 1480, height: 940, minWidth: 1080, minHeight: 720, title: '风沙全平台视频下载器', frame: false, backgroundColor: '#f8fafc', icon: path.join(root, 'assets', 'icon.png'), show: false, webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), sandbox: true, nodeIntegration: false, contextIsolation: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => { if (!background && (!testMode || process.env.FENGSHA_TEST_VISIBLE === '1')) win.show(); });
  win.on('close', async e => {
    if (closing) return; e.preventDefault();
    if (queue.active.size || transcriptions.active) { const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['继续处理', '暂停任务并退出'], defaultId: 0, cancelId: 0, message: '仍有下载或转录任务，是否暂停并退出？', detail: '任务与已完成文稿保留，下次启动可以继续处理。' }); if (r.response === 0) return; }
    closing = true; clearTimeout(changedTimer); clearInterval(agentIdleTimer); agentServer?.close(); await creators.close(); await transcriptions.close(); await queue.close(); await collectorConnection.close().catch(()=>{}); await accounts.flushAll(); store.close(); win.destroy(); app.quit();
  });
  app.on('before-quit', e => { if (!closing && !quitting) { e.preventDefault(); quitting = true; clearTimeout(changedTimer); clearInterval(agentIdleTimer); agentServer?.close(); void creators.close().then(() => transcriptions.close()).then(() => queue.close()).then(()=>collectorConnection.close().catch(()=>{})).then(() => accounts.flushAll()).then(() => { store.close(); closing = true; app.quit(); }); } });
  if (testMode) globalThis.fengshaTest = { store, queue, engine, creators, accounts, ai, transcriptions, wechatCreators, collectorConnection, snapshot, win };
  await win.loadFile(path.join(root, 'dist', 'index.html'));
  const agentBusy = type => type === 'parse' ? Boolean(parseProgress) : Boolean(parseProgress || creators.progress() || transcriptions.active || queue.active.size || queue.tasks().some(t => ['queued', 'retry-wait'].includes(t.status)) || (agentServer?.active || 0) > 1);
  agentServer = await startAgentServer(app.getPath('userData'), createAgentHandler({ engine, queue, store, accounts, creators, parse: parseLinks,
    identify: source => { if (parseProgress) throw new Error('正在识别视频，请稍后识别博主'); const urls = linksFromText(source); if (urls.length !== 1) throw new Error('请提供一个视频或主页链接'); return creators.identify(urls[0]); },
    busy: agentBusy, creatorChanged: record => { if (win && !win.isDestroyed()) win.webContents.send('fengsha:creator-changed', record); }, status: () => ({ version: app.getVersion(), pid: process.pid, background: !win.isVisible(), dataDirectory: app.getPath('userData'), activeTasks: queue.active.size }), stop: () => setTimeout(() => app.quit(), 100) }));
  agentIdleTimer = setInterval(() => { if (background && !win.isVisible() && !agentBusy() && !agentServer.active && Date.now() - agentServer.lastUsed > 30000) app.quit(); }, 1000);
  agentIdleTimer.unref();
  if (testMode) console.error('FENGSHA_BOOT: renderer');
  void engine.environment().then(value => { environment = value; changed(); }); queue.pump();
}
