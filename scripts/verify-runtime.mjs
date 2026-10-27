import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertRuntimeBundle } from '../electron/runtime-readiness.js';

export function verifyRuntime(bin = path.resolve('bin'), { run = execFileSync, environment = process.env } = {}) {
  const inventory = assertRuntimeBundle(bin);
  const env = { ...environment };
  for (const key of Object.keys(env)) if (/^(pythonpath|pythonhome|virtual_env|path)$/i.test(key)) delete env[key];
  env.PATH = path.join(environment.SystemRoot || 'C:\\Windows', 'System32');
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.HF_HUB_OFFLINE = '1';
  env.TRANSFORMERS_OFFLINE = '1';
  const probes = [
    ['下载组件', 'yt-dlp.exe', ['--version']],
    ['音视频处理', 'ffmpeg/ffmpeg.exe', ['-version']],
    ['媒体校验', 'ffmpeg/ffprobe.exe', ['-version']],
    ['独立 Node', 'node/node.exe', ['--version']],
    ['电脑微信文章采集', 'collector/wechat-article-helper.exe', ['--version']],
    ['离线语音与完整模型', 'asr/runtime/python.exe', ['-I', '-B', '-c',
      'import sys; import av, ctranslate2; from faster_whisper import WhisperModel; ' +
      '[WhisperModel(p, device="cpu", compute_type="int8", local_files_only=True) for p in sys.argv[1:]]; print("base/small offline ready")',
      path.join(bin, 'asr/models/base'), path.join(bin, 'asr/models/small')]],
  ];
  const components = [];
  for (const [name, relative, args] of probes) {
    try {
      const output = run(path.join(bin, relative), args, { env, windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      components.push({ name, ok: true, version: String(output).split(/\r?\n/)[0].slice(0, 160) });
    } catch {
      throw new Error(`完整安装包检查失败：${name}不能在包内环境独立运行。请补齐该组件；未继续生成安装包。`);
    }
  }
  return { ...inventory, offline: true, components };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(verifyRuntime(path.resolve(process.argv[2] || 'bin')), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
