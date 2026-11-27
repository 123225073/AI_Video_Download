import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const output = path.resolve('bin/collector/wechat-article-helper.exe');
if (process.platform === 'win32') {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const sourcePath = path.resolve('electron/wechat-article-helper.cs');
  const source = fs.readFileSync(sourcePath, 'utf8');
  if (source.slice(0, 64).includes('%TSD-Header')) {
    throw Error('微信文章采集源码当前不可读取，未替换组件');
  }
  const runtime = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  execFileSync(
    path.join(runtime, 'csc.exe'),
    [
      '/noconfig', '/nologo', '/target:exe', '/platform:anycpu',
      '/r:System.dll', '/r:System.Core.dll', '/r:System.Web.dll', '/r:System.Web.Extensions.dll',
      ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => '/r:' + path.join(runtime, 'WPF', name)),
      '/out:' + output,
      sourcePath,
    ],
    { windowsHide: true, stdio: 'inherit' },
  );
} else if (!fs.existsSync(output)) {
  throw Error('Missing desktop WeChat article helper');
}
console.log('Prepared desktop WeChat article helper');
