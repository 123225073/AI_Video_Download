import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs, selectItems } from '../cli/options.mjs';
import { createAgentHandler, startAgentServer, publicItem } from '../electron/agent.js';
import { request, pipePath } from '../cli/protocol.mjs';

test('CLI 参数保留中文和含空格目录，非法选项与隐式批量下载明确拒绝', () => {
  const p = parseArgs(['download', 'https://www.youtube.com/watch?v=abc', '--output', 'D:\\视频 素材', '--indices', '1,2', '--json']);
  assert.equal(p.options.output, 'D:\\视频 素材');
  for (const args of [['download'], ['inspect'], ['task', '--id', 'a', '--action', 'delete'], ['download', 'url', '--all', '--indices', '1'], ['inspect', 'url', '--timeout', '-1'], ['download', 'url', '--list', 'x.json'], ['help', '--unknown']]) assert.throws(() => parseArgs(args));
  assert.throws(() => selectItems([1, 2], {}), { code: 'SELECTION_REQUIRED' });
  assert.deepEqual(selectItems([1, 2], { indices: '2,2' }), [2]);
  assert.throws(() => selectItems([1], { indices: '0' }), { code: 'INVALID_SELECTION' });
});
test('CLI 清单与任务不泄露账号会话、签名媒体地址和下载诊断日志', async () => {
  const item = { url: 'https://www.youtube.com/watch?v=abc', platform: 'YouTube', title: '示例', accountId: 'secret-account', cookie: 'SECRET', decodeKey: 'SECRET', formats: [{ url: 'SECRET' }] };
  const queue = { tasks: () => [{ id: 'task', item, status: 'completed', logs: 'SECRET', filePath: 'video.mp4' }], scheduler: () => ({}) };
  const handler = createAgentHandler({ queue });
  assert.ok(!JSON.stringify(publicItem(item)).includes('SECRET'));
  const result = await handler({ command: 'tasks' });
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.equal(result.tasks[0].filePath, 'video.mp4');
});
test('CLI 部分解析失败不盲目下载，平台伪造与超过提交上限拒绝', async () => {
  let enqueued = 0;
  const handler = createAgentHandler({ parse: async () => [{ error: '登录失效', items: [] }], queue: { enqueue: () => { enqueued++; } } });
  await assert.rejects(handler({ command: 'download', source: 'url' }), { code: 'PARSE_FAILED' });
  await assert.rejects(handler({ command: 'download', options: { all: true }, items: Array.from({ length: 1001 }, () => ({ url: 'https://youtu.be/abc', platform: 'YouTube' })) }), { code: 'BATCH_LIMIT' });
  await assert.rejects(handler({ command: 'download', items: [{ url: 'https://youtu.be/abc', platform: 'B站' }] }), /平台与链接不一致/);
  assert.equal(enqueued, 0);
});
test('CLI 博主分页有界并保留中断结果，继续读取使用现有记录', async () => {
  let calls = 0;
  const original = { id: 'r', creator: { id: 'author', platform: 'YouTube', accountId: 'hidden' }, items: [], scanned: 0 };
  const handler = createAgentHandler({ store: { get: () => original }, busy: () => false, identify: async () => original, creators: { page: async () => ({ ...original, scanned: ++calls * 50, status: calls === 2 ? 'interrupted' : 'partial', message: '请求受限', items: [] }) } });
  const result = await handler({ command: 'creator', source: 'url', options: { limit: 150 } });
  assert.equal(calls, 2); assert.equal(result.partial, true); assert.equal(result.scanned, 100); assert.equal(result.creator.accountId, undefined);
});
test('本机 CLI 通道要求认证，分块中文 JSON 可正确返回，超时不冒充完成', async () => {
  const directory = path.resolve('output', 'unit', randomUUID()); fs.mkdirSync(directory, { recursive: true });
  const server = await startAgentServer(directory, async ({ command }) => { if (command === 'slow') await new Promise(r => setTimeout(r, 100)); return { text: '中文资料', command }; });
  try {
    const result = await request(directory, { command: 'test' }); assert.equal(result.data.text, '中文资料');
    const denial = await new Promise((resolve, reject) => {
      const client = net.createConnection(pipePath(directory)); client.setEncoding('utf8'); let body = '';
      client.on('connect', () => client.write(JSON.stringify({ token: 'wrong', command: 'test' }) + '\n'));
      client.on('data', d => { body += d; if (body.includes('\n')) { client.destroy(); resolve(JSON.parse(body)); } }); client.on('error', reject);
    });
    assert.equal(denial.error.code, 'UNAUTHORIZED');
    await assert.rejects(request(directory, { command: 'slow' }, 10), { code: 'TIMEOUT' });
  } finally { server.close(); }
});

test('CLI下载等待共用一次超时预算，轮询超时仍返回已入队任务ID', async () => {
  const directory=path.resolve('output','unit',randomUUID());fs.mkdirSync(directory,{recursive:true});
  let submittedAt;
  const server=await startAgentServer(directory,async({command})=>{
    if(command==='service')return {};
    if(command==='download'){submittedAt=Date.now();await new Promise(r=>setTimeout(r,750));return {added:['queued-task'],skipped:[]};}
    await new Promise(r=>setTimeout(r,1200));return {tasks:[{id:'queued-task',status:'downloading'}]};
  });
  const argv=process.argv,exitCode=process.exitCode,write=process.stdout.write;
  try{
    // Run the real entry point and pipe in-process; packaged subprocess startup
    // and bundled Node are covered by packaged-cli-smoke.mjs.
    let stdout='';process.argv=[process.execPath,path.resolve('cli/fengsha.mjs'),'download','https://youtu.be/test','--timeout','1','--data-dir',directory];
    process.stdout.write=function(chunk,...args){if(String(chunk).startsWith('{"ok"')){stdout+=chunk;return true;}return write.call(this,chunk,...args);};
    await import(pathToFileURL(path.resolve('cli/fengsha.mjs')).href+'?test='+randomUUID());
    const response=JSON.parse(stdout);assert.equal(process.exitCode,3,stdout);assert.equal(response.error.code,'TIMEOUT');assert.deepEqual(response.data.added,['queued-task']);assert.ok(Date.now()-submittedAt<1700,'超时预算不能在入队后重新计算');
  }finally{process.argv=argv;process.exitCode=exitCode;process.stdout.write=write;server.close();}
});
