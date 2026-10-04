import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../electron/store.js';
const require = createRequire(import.meta.url), root = path.resolve('.');
const output = path.resolve('output', `creator-recovery-${Date.now()}`), directory = path.join(output, 'profile');
const source = 'https://channels.weixin.qq.com/web/pages/profile?username=recovery_author';
const store = await Store.open(directory, {});
const record = { id: 'recovery-case', source, creator: { name: '恢复测试作者', platform: '视频号', supported: false, needsCollector: true, reason: '等待采集连接' }, items: [], scanned: 0, seen: [], skipped: {}, status: 'needs-connection', createdAt: Date.now() };
store.put('creator', record.id, record); store.put('meta', 'lastCreator', { id: record.id }); store.flush(); clearTimeout(store.timer); store.db.close();
const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
let app; const result = { output, ok: false };
try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], env });
  const page = await app.firstWindow(); await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  assert.equal(await page.getByLabel('视频链接').inputValue(), '');
  await app.evaluate(() => { globalThis.fengshaTest.creators.identify = async source => { globalThis.recoveredSource = source; return globalThis.fengshaTest.creators.last(); }; });
  await page.getByRole('button', { name: '继续上次博主清单', exact: true }).click();
  await page.getByRole('button', { name: '重新识别原链接', exact: true }).click();
  await page.getByRole('heading', { name: '恢复测试作者', exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.recoveredSource), source);
  result.originalSourceRetained = true; result.ok = true;
} catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
finally { await app?.close(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
