import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

// These are application resources, never system-wide dependencies. Keep the
// complete speech models in the installer so first use also works offline.
export const runtimeFiles = [
  'yt-dlp.exe', 'ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe', 'node/node.exe',
  'collector/wx_video_download.exe', 'collector/collector-native.dll',
  'collector/wechat-window-helper.exe', 'collector/wechat-article-helper.exe', 'collector/collector-system.ps1',
  'collector/collector-content.js', 'collector/clash-route-helper.cjs',
  'wechat/download-link.cjs', 'wechat/decrypt.cjs', 'asr/transcribe.py',
  'asr/runtime/python.exe', 'asr/runtime/python312.dll', 'asr/runtime/python312.zip',
  'asr/runtime/python312._pth', 'asr/runtime/vcruntime140.dll', 'asr/runtime/vcruntime140_1.dll',
  ...['base', 'small'].flatMap(model => ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'].map(file => `asr/models/${model}/${file}`)),
  'LICENSE-yt-dlp.txt', 'ffmpeg/LICENSE.txt', 'node/LICENSE', 'collector/LICENSE',
  'collector/LICENSE-yaml', 'asr/runtime/LICENSE.txt',
];
const collectorSHA256 = '5e0a943793f44b22dab938b0a0b49a7ce6c20a5a6119389c93f1495dda082d79';

export function inspectRuntimeBundle(bin, { verifyCollectorHash = true } = {}) {
  const issues = [];
  for (const relative of runtimeFiles) {
    const file = path.join(bin, relative);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || !stat.size) { issues.push({ file: relative, reason: '文件为空或不是文件' }); continue; }
      if (/\.(exe|dll)$/.test(relative)) {
        const handle = fs.openSync(file, 'r');
        try { const header = Buffer.alloc(2); fs.readSync(handle, header, 0, 2, 0); if (header.toString() !== 'MZ') issues.push({ file: relative, reason: 'Windows 组件内容无效' }); }
        finally { fs.closeSync(handle); }
      } else if (relative.endsWith('.json')) {
        JSON.parse(fs.readFileSync(file, 'utf8'));
      } else if (/\.(js|cjs)$/.test(relative)) {
        new Script(fs.readFileSync(file, 'utf8'), { filename: relative });
      }
    } catch { issues.push({ file: relative, reason: '文件缺失、不可读取或内容无效' }); }
  }
  const collector = path.join(bin, 'collector/wx_video_download.exe');
  if (verifyCollectorHash && !issues.some(issue => issue.file === 'collector/wx_video_download.exe')) {
    try {
      if (createHash('sha256').update(fs.readFileSync(collector)).digest('hex') !== collectorSHA256) {
        issues.push({ file: 'collector/wx_video_download.exe', reason: '视频号组件版本或校验值不匹配' });
      }
    } catch { issues.push({ file: 'collector/wx_video_download.exe', reason: '视频号组件不可读取' }); }
  }
  return { ok: issues.length === 0, checked: runtimeFiles.length, issues };
}

export function assertRuntimeBundle(bin, options) {
  const result = inspectRuntimeBundle(bin, options);
  if (!result.ok) {
    const error = new Error('完整安装包组件检查未通过，已停止打包：\n' + result.issues.map(issue => `${issue.file}：${issue.reason}`).join('\n'));
    error.code = 'RUNTIME_INCOMPLETE';
    error.issues = result.issues;
    throw error;
  }
  return result;
}
