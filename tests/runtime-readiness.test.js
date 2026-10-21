import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runtimeFiles, inspectRuntimeBundle, assertRuntimeBundle } from '../electron/runtime-readiness.js';

function fixture(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fengsha-runtime-'));
  for (const relative of runtimeFiles) {
    const file = path.join(bin, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, /\.(exe|dll)$/.test(relative) ? 'MZfixture' : relative.endsWith('.json') ? '{}' : '/* fixture */');
  }
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  return bin;
}

test('完整组件清单通过；模型仅有 model.bin 时在打包前拒绝', t => {
  const bin = fixture(t);
  assert.equal(inspectRuntimeBundle(bin, { verifyCollectorHash: false }).ok, true);
  fs.unlinkSync(path.join(bin, 'asr/models/base/tokenizer.json'));
  assert.throws(() => assertRuntimeBundle(bin, { verifyCollectorHash: false }), error => error.code === 'RUNTIME_INCOMPLETE' && error.issues.some(issue => issue.file === 'asr/models/base/tokenizer.json'));
});

test('缺失 FFmpeg、空 Node 与损坏 Python 不能成为完整安装包', t => {
  const bin = fixture(t);
  fs.unlinkSync(path.join(bin, 'ffmpeg/ffmpeg.exe'));
  fs.writeFileSync(path.join(bin, 'node/node.exe'), '');
  fs.writeFileSync(path.join(bin, 'asr/runtime/python.exe'), '%TSD-Header-###%');
  const result = inspectRuntimeBundle(bin, { verifyCollectorHash: false });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => issue.file).sort(), ['asr/runtime/python.exe', 'ffmpeg/ffmpeg.exe', 'node/node.exe']);
});

test('视频号组件校验值不符时拒绝，不能把不兼容上游程序分发给用户', t => {
  const result = inspectRuntimeBundle(fixture(t));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.file === 'collector/wx_video_download.exe' && issue.reason.includes('校验值')));
});

test('损坏模型 JSON 和加密脚本在构建时报告具体文件', t => {
  const bin = fixture(t);
  fs.writeFileSync(path.join(bin, 'asr/models/small/config.json'), '{bad');
  fs.writeFileSync(path.join(bin, 'collector/collector-content.js'), '%TSD-Header-###%');
  const result = inspectRuntimeBundle(bin, { verifyCollectorHash: false });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 2);
});
