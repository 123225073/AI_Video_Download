import { spawn } from 'node:child_process';

export function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}
export function command(binary, args, { signal, timeout = 120000, onLine, collectOutput = true } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('CANCELLED')); return; }
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', ended = false, timedOut = false, tooLarge = false;
    const abort = () => stopProcess(child);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stopProcess(child); }, timeout);
    function readStream(stream, isStdout) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', value => {
        if (tooLarge) return;
        if (isStdout && collectOutput) {
          output += value;
          if (output.length > 24 * 1024 * 1024) { tooLarge = true; stopProcess(child); return; }
        } else if (!isStdout) errors = (errors + value).slice(-12000);
        if (onLine) {
          const lines = (pending + value).split(/\r?\n/);
          pending = lines.pop();
          for (const line of lines) onLine(line);
        }
      });
      stream.on('end', () => { if (pending && !tooLarge) onLine(pending); });
    }
    readStream(child.stdout, true);
    readStream(child.stderr, false);
    const finish = (error, code) => {
      if (ended) return; ended = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('CANCELLED'));
      else if (error) reject(error);
      else if (timedOut) reject(new Error('Connection timed out'));
      else if (tooLarge) reject(new Error('清单过大，请缩小解析范围'));
      else if (code !== 0) reject(new Error(errors || `下载组件退出：${code}`));
      else resolve(output);
    };
    child.once('error', e => finish(e)); child.once('close', code => finish(null, code));
  });
}
