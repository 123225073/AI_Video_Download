import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Engine } from '../electron/engine.js';
import { classifyError, safeLog } from '../electron/core.js';
const root = path.resolve('.'), output = path.join(root, 'output', `platform-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const engine = new Engine(path.join(root, 'bin'), null, null);
const samples = [
  ['YouTube', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
  ['B站', 'https://www.bilibili.com/video/BV1gVbx6hExy?p=2'],
  ['抖音', 'https://www.douyin.com/video/6961737553342991651'],
  ['小红书', 'https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9']
];
const results = await Promise.all(samples.filter(([platform]) => !process.argv[2] || process.argv[2].split(',').includes(platform)).map(async ([platform, url]) => {
  const result = { platform, url, account: '无账号', parsed: false, downloaded: false, fullDecode: false, startedAt: new Date().toISOString() };
  try {
    const group = await engine.parse(url, { limit: 3 }); result.parsed = true; result.count = group.items.length; result.complete = group.complete;
    const item = group.items.find(i => i.available); if (!item) throw new Error('没有可下载条目');
    const downloaded = await engine.download({ id: randomUUID(), item, options: { quality: '480', force: false } }, path.join(output, platform), undefined, () => {});
    result.downloaded = true; Object.assign(result, downloaded);
    execFileSync(path.join(root, 'bin/ffmpeg/ffmpeg.exe'), ['-v', 'error', '-xerror', '-i', downloaded.filePath, '-fps_mode', 'passthrough', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }); result.fullDecode = true;
  } catch (error) { result.error = { ...classifyError(error.message), detail: safeLog(error.message) }; }
  console.log(`${platform}: 解析${result.parsed ? '成功' : '失败'}，下载${result.downloaded ? '成功' : '未完成'}`); return result;
}));
results.push({ platform: '视频号', account: '未提供账号和有效分享链接', parsed: false, downloaded: false, status: '待用户登录后验证', tested: false });
const report = { testedAt: new Date().toISOString(), environment: await engine.environment(), results };
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(output);
