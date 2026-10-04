// Run only after the user approved moving this app's data and video directory.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), initSqlJs = require('sql.js');
(async () => {
  const dataDirectory = process.argv[2], videoDirectory = process.argv[3], oldVideoDirectory = process.argv[4];
  if (!dataDirectory || !videoDirectory || !oldVideoDirectory || !dataDirectory.startsWith('D:\\') || !videoDirectory.startsWith('D:\\')) throw new Error('迁移目录必须是已确认的D盘目录');
  const file = path.join(dataDirectory, 'library.sqlite'), bytes = fs.readFileSync(file);
  const sourceDatabaseHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) }), db = new SQL.Database(bytes);
  const statement = db.prepare('SELECT kind,id,data FROM records'); const updates = [];
  const relocate = original => {
    if (!original) return original;
    const relative = path.relative(oldVideoDirectory, original);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return original;
    return path.join(videoDirectory, relative);
  };
  try {
    while (statement.step()) {
      const row = statement.getAsObject(), value = JSON.parse(row.data);
      if (['media', 'task'].includes(row.kind) && value.filePath) { const next = relocate(value.filePath); if (next !== value.filePath && !fs.existsSync(next)) throw new Error('迁移后视频缺失，未更新数据库'); value.filePath = next; }
      if (row.kind === 'task' && value.options?.savePath) value.options.savePath = relocate(value.options.savePath);
      if (row.kind === 'settings' && row.id === 'main') value.savePath = videoDirectory;
      if (JSON.stringify(value) !== row.data) updates.push({ kind: row.kind, id: row.id, value });
    }
  } finally { statement.free(); }
  const backup = path.join(dataDirectory, 'library.before-D-migration.sqlite');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, bytes);
  db.run('BEGIN'); for (const row of updates) db.run('UPDATE records SET data=? WHERE kind=? AND id=?', [JSON.stringify(row.value), row.kind, row.id]); db.run('COMMIT');
  fs.writeFileSync(file + '.migration', db.export()); fs.renameSync(file + '.migration', file); db.close();
  console.log(JSON.stringify({ recordsUpdated: updates.length, dataDirectory, videoDirectory, sourceDatabaseHash, rollbackDatabase: backup }, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
