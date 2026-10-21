#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { parseArgs, usage } from './options.mjs';
import { request } from './protocol.mjs';
import { storagePaths, prepareDataDirectory } from './storage-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = fs.existsSync(path.join(root, 'app.asar'));
const defaultDirectory = () => storagePaths({ packaged, executable: path.resolve(root, '..', 'FengshaVideoDownloader.exe'), sourceRoot: root }).dataDirectory;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let parsed, directory;
async function connect() {
  try { return await request(directory, { command: 'service' }, 10000); }
  catch (error) {
    if (!['SERVICE_UNAVAILABLE', 'ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let executable, args;
  if (packaged) { executable = path.resolve(root, '..', 'FengshaVideoDownloader.exe'); args = []; }
  else { executable = createRequire(import.meta.url)('electron'); args = [root]; }
  const child = spawn(executable, [...args, '--agent-background', '--agent-data-dir', directory], { env, windowsHide: true, detached: true, stdio: 'ignore' });
  let spawnError; child.on('error', e => { spawnError = e; }); child.unref();
  const startupDeadline = Date.now() + 45000;
  while (Date.now() < startupDeadline) {
    if (spawnError) throw spawnError;
    await delay(250);
    try { return await request(directory, { command: 'service' }, 2000); }
    catch (e) { if (!['SERVICE_UNAVAILABLE', 'ENOENT', 'ECONNREFUSED', 'TIMEOUT'].includes(e.code)) throw e; }
  }
  throw Object.assign(new Error('后台启动失败或当前桌面版本不支持 CLI；请更新版本并查看安装部署说明'), { code: 'STARTUP_FAILED' });
}
async function run() {
  try { parsed = parseArgs(process.argv.slice(2)); } catch (e) { e.exitCode = 2; e.code = 'INVALID_ARGUMENT'; throw e; }
  if (parsed.command === 'help') return { ok: true, data: usage() };
  if (parsed.command === 'version') {
    const metadata = packaged ? JSON.parse(fs.readFileSync(path.join(root, 'cli', 'version.json'), 'utf8')) : JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return { ok: true, data: { name: 'fengsha-cli', version: metadata.version } };
  }
  directory = path.resolve(parsed.options['data-dir'] || (process.env.FENGSHA_TEST_MODE === '1' && process.env.FENGSHA_TEST_DATA) || defaultDirectory());
  prepareDataDirectory(directory);
  if (parsed.options.output) parsed.options.output = path.resolve(parsed.options.output);
  if (parsed.options.file) parsed.options.file = path.resolve(parsed.options.file);
  if (parsed.options.list) {
    let manifest; try { manifest = JSON.parse(fs.readFileSync(path.resolve(parsed.options.list), 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw Object.assign(new Error('清单文件不存在或不是 UTF-8 JSON'), { code: 'INVALID_MANIFEST', exitCode: 2 }); }
    parsed.items = Array.isArray(manifest) ? manifest : manifest.data?.items || manifest.items;
    if (!Array.isArray(parsed.items)) throw Object.assign(new Error('清单需为数组或包含 items；可直接保存 inspect / creator 的 JSON 输出'), { code: 'INVALID_MANIFEST', exitCode: 2 });
  }
  const ready = await connect(); if (!ready.ok) return ready;
  const timeout = (parsed.options.timeout || 3600) * 1000;
  const deadline = Date.now() + timeout;
  let result = await request(directory, parsed, timeout);
  if (parsed.command !== 'download' || !result.ok || parsed.options['no-wait'] || !result.data.added.length) return result;
  const ids = new Set(result.data.added), enqueue = result.data;
  while (Date.now() < deadline) {
    let reply;
    try { reply = await request(directory, { command: 'tasks' }, Math.max(1, Math.min(30000, deadline - Date.now()))); }
    catch (error) { if (error.code === 'TIMEOUT') break; throw error; }
    if (!reply.ok) return { ...reply, data: { ...enqueue } };
    const tasks = reply.data.tasks.filter(t => ids.has(t.id));
    if (tasks.length !== ids.size) return { ok: false, error: { code: 'TASK_MISSING', message: '部分任务记录缺失，请查询任务状态' }, data: { ...enqueue, tasks }, exitCode: 1 };
    if (tasks.every(t => ['completed', 'failed', 'cancelled', 'paused'].includes(t.status))) {
      const ok = tasks.every(t => t.status === 'completed');
      return { ok, command: 'download', data: { ...enqueue, tasks, files: tasks.filter(t => t.status === 'completed').map(t => ({ taskId: t.id, filePath: t.filePath, size: t.size, duration: t.duration })) }, ...(ok ? {} : { error: { code: 'DOWNLOAD_INCOMPLETE', message: '部分任务未完成，请根据任务状态处理后重试' }, exitCode: 4 }) };
    }
    await delay(Math.max(0, Math.min(500, deadline - Date.now())));
  }
  return { ok: false, command: 'download', error: { code: 'TIMEOUT', message: '等待超时；任务继续在后台执行，请查询 tasks，不要重复提交' }, data: enqueue, exitCode: 3 };
}
try {
  const result = await run(); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : result.exitCode || 1;
} catch (e) {
  // No raw service response, token, cookie or command URL is printed on failures.
  const message = String(e.message).replace(/https?:\/\/\S+/g, '[链接已隐藏]').replace(/(cookie|authorization|token)[=: ].*/ig, '$1=[已隐藏]');
  process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code || 'CLI_FAILED', message }, exitCode: e.exitCode || 1 }) + '\n'); process.exitCode = e.exitCode || 1;
}
