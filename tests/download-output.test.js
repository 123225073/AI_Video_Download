import test from 'node:test';
import assert from 'node:assert/strict';
import { command } from '../electron/process-output.js';

test('下载工具分段写入中文路径和多行进度时按完整行读取', async () => {
  const lines = [];
  const script = `
    const bytes = Buffer.from('媒体.mp4');
    process.stdout.write(bytes.subarray(0, 1));
    process.stderr.write('进度 1\\n进');
    setTimeout(() => {
      process.stdout.write(bytes.subarray(1));
      process.stderr.write('度 2\\n进度 3');
    }, 100);
  `;
  const output = await command(process.execPath, ['-e', script], { onLine: line => lines.push(line) });
  assert.equal(output, '媒体.mp4');
  assert.deepEqual(lines.sort(), ['媒体.mp4', '进度 1', '进度 2', '进度 3'].sort());
});

test('长下载只流式处理进度，不占用解析清单的输出限额', async () => {
  let lines = 0;
  const script = "process.stdout.end(('x'.repeat(32767) + '\\n').repeat(800))";
  const output = await command(process.execPath, ['-e', script], { collectOutput: false, onLine: () => { lines++; } });
  assert.equal(lines, 800);
  assert.equal(output, '');
});
