import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
export const channelFile = directory => path.join(directory, '.agent-channel.json');
export function pipePath(directory) {
  const identity = path.resolve(directory), normalized = process.platform === 'win32' ? identity.toLowerCase() : identity;
  const hash = createHash('sha256').update(`${os.userInfo().username}|${normalized}`).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\fengsha-agent-${hash}` : path.join(os.tmpdir(), `fengsha-agent-${hash}.sock`);
}
export function request(directory, payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let token; try { token = JSON.parse(fs.readFileSync(channelFile(directory), 'utf8')).token; } catch { return reject(Object.assign(new Error('后台尚未运行'), { code: 'SERVICE_UNAVAILABLE' })); }
    const socket = net.createConnection(pipePath(directory)); socket.setEncoding('utf8'); let body = '', settled = false;
    const done = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => done(Object.assign(new Error('命令等待超时；已入队任务不会自动取消，请查询 tasks'), { code: 'TIMEOUT', exitCode: 3 })), timeout);
    socket.on('connect', () => socket.write(JSON.stringify({ token, ...payload }) + '\n'));
    socket.on('error', error => done(error));
    socket.on('data', data => { body += data.toString('utf8'); if (body.length > 24 * 1024 * 1024) return done(new Error('返回清单过大，请缩小范围')); if (!body.includes('\n')) return; try { done(null, JSON.parse(body.slice(0, body.indexOf('\n')))); } catch { done(new Error('后台返回无效 JSON')); } });
    socket.on('close', () => { if (!settled) done(new Error('后台连接关闭，未取得完整结果')); });
  });
}
