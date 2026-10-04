import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
const require = createRequire(import.meta.url);

export class Store {
  static async open(directory, defaults) {
    fs.mkdirSync(directory, { recursive: true });
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
    return new Store(SQL, directory, defaults);
  }
  constructor(SQL, directory, defaults) {
    this.file = path.join(directory, 'library.sqlite');
    this.db = fs.existsSync(this.file) ? new SQL.Database(fs.readFileSync(this.file)) : new SQL.Database();
    this.db.run('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT);');
    this.defaults = defaults;
    this.put('meta', 'schema', { version: 1 });
  }
  get(kind, id) {
    const stmt = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?');
    try { stmt.bind([kind, id]); return stmt.step() ? JSON.parse(stmt.getAsObject().data) : null; } finally { stmt.free(); }
  }
  list(kind) {
    const stmt = this.db.prepare('SELECT data FROM records WHERE kind=?');
    const values = [];
    try { stmt.bind([kind]); while (stmt.step()) values.push(JSON.parse(stmt.getAsObject().data)); } finally { stmt.free(); }
    return values;
  }
  put(kind, id, value) {
    this.db.run('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data', [kind, id, JSON.stringify(value)]);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  settings() { return { ...this.defaults, ...(this.get('settings', 'main') || {}) }; }
  flush() {
    clearTimeout(this.timer);
    const data = this.db.export();
    const handle = fs.openSync(`${this.file}.tmp`, 'w');
    try { fs.writeFileSync(handle, data); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    // Windows scanners can briefly hold the destination immediately after a write.
    // Keep the previous database intact and retry the atomic rename, never delete it.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(`${this.file}.tmp`, this.file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
      }
    }
  }
  close() { this.flush(); this.db.close(); }
}
