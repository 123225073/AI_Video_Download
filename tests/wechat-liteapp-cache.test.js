import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheDirHasStaleLibpag, inspectLiteAppSdkCache, prepareLiteAppSdkCache } from '../electron/wechat-liteapp-cache.js';

function makeProfile(root, name, content) {
  const cacheDir = path.join(root, name, 'Cache', 'Cache_Data');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'index'), Buffer.alloc(64));
  fs.writeFileSync(path.join(cacheDir, 'data_1'), content);
  return cacheDir;
}

test('识别微信 4.2 Blockfile 缓存中的未注入 libpag.min.js；微信运行时不强行移动', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengsha-liteapp-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheDir = makeProfile(root, 'multitab_user1', Buffer.from('...https://res.wx.qq.com/t/wx_fed/cdn_libs/res/libpag/4.3.48/libpag.min.js...'));
  assert.equal(cacheDirHasStaleLibpag(cacheDir), true);

  const blocked = await prepareLiteAppSdkCache({ profilesRoot: root, isRunning: async () => true });
  assert.equal(blocked.status, 'needs-wechat-restart');
  assert.equal(blocked.cleaned, 0);
  assert.equal(fs.existsSync(cacheDir), true);

  const cleaned = await prepareLiteAppSdkCache({ profilesRoot: root, isRunning: async () => false });
  assert.equal(cleaned.status, 'cleaned');
  assert.equal(cleaned.cleaned, 1);
  assert.equal(fs.existsSync(cacheDir), false);
  assert.equal(fs.existsSync(path.join(cleaned.backupDirs[0], 'Cache_Data', 'data_1')), true);

  const after = await inspectLiteAppSdkCache({ profilesRoot: root, isRunning: async () => false });
  assert.equal(after.hasStaleCache, false);
});

test('不含 libpag 的微信缓存保持原样不被触碰', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengsha-liteapp-clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheDir = makeProfile(root, 'webview_user1', Buffer.from('https://example.com/other.js'));
  const result = await prepareLiteAppSdkCache({ profilesRoot: root, isRunning: async () => false });
  assert.equal(result.status, 'clean');
  assert.equal(result.cleaned, 0);
  assert.equal(fs.existsSync(cacheDir), true);
});
