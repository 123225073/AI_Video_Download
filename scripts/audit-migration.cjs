const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict');
const { execFileSync } = require('child_process'), initSqlJs = require('sql.js');
(async () => {
  const before = JSON.parse(fs.readFileSync('output/release-0.2.0/before-install.json', 'utf8'));
  const after = JSON.parse(fs.readFileSync('output/release-0.2.0/after-install.json', 'utf8'));
  const identity = rows => rows.map(({ id, platform, name, lastSync }) => ({ id, platform, name, lastSync })).sort((a,b) => a.id.localeCompare(b.id));
  assert.deepEqual(identity(before.accounts), identity(after.accounts)); assert.deepEqual(before.activeAccounts, after.activeAccounts);
  assert.deepEqual(before.taskIds, after.taskIds); assert.deepEqual(before.mediaIds, after.mediaIds);
  const data = 'D:/9005_IDEauthorized/风沙应用/风沙全平台视频下载器/用户数据';
  const backupHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(data, 'library.before-D-migration.sqlite'))).digest('hex'); assert.equal(backupHash, before.databaseHash);
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) }), db = new SQL.Database(fs.readFileSync(path.join(data, 'library.sqlite')));
  const s = db.prepare("SELECT data FROM records WHERE kind='media'"); const videos = [];
  while (s.step()) {
    const m = JSON.parse(s.getAsObject().data); assert.ok(m.filePath.startsWith('D:\\')); assert.ok(fs.existsSync(m.filePath));
    const ffprobe = path.resolve('bin/ffmpeg/ffprobe.exe'), ffmpeg = path.resolve('bin/ffmpeg/ffmpeg.exe');
    const metadata = JSON.parse(execFileSync(ffprobe, ['-v','error','-show_format','-show_streams','-of','json',m.filePath], { windowsHide:true }).toString());
    assert.ok(metadata.streams.some(s => s.codec_type === 'video'));
    execFileSync(ffmpeg, ['-v','error','-xerror','-i',m.filePath,'-fps_mode','passthrough','-f','null','-'], { windowsHide:true });
    videos.push({ platform: m.platform, bytes: fs.statSync(m.filePath).size, duration: Number(metadata.format.duration), fullDecode: true });
  }
  s.free(); db.close();
  const report = { ok:true, accountsPreserved:before.accounts.length, tasksPreserved:before.taskIds.length, mediaPreserved:before.mediaIds.length, activeAccountSelectionPreserved:true, rollbackDatabaseHashMatches:true, encryptedSessionStillPresent:after.sessions.filter(s => s.exists).length, videos, note:'小红书原登录窗口经用户允许正常关闭，登录中状态恢复为未登录，需重新登录；未使用真实账号执行网络下载测试。' };
  fs.writeFileSync('output/release-0.2.0/migration-audit.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
})().catch(e => { console.error(e.stack); process.exitCode=1; });
