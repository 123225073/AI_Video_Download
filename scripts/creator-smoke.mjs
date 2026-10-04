import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../electron/store.js';
import { Engine } from '../electron/engine.js';
import { Creators } from '../electron/creators.js';
import { safeLog } from '../electron/core.js';
const output = path.resolve('output', `creator-live-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const engine = new Engine(path.resolve('bin'), null, null), store = await Store.open(path.join(output, 'profile'), {});
const service = new Creators(store, engine, null, () => {}), results = [];
for (const [platform, source] of [['YouTube', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'], ['B站', 'https://www.bilibili.com/video/BV1gVbx6hExy?p=2']]) {
  const r = { platform, source, credentials: '无账号', identified: false, listRead: false };
  try {
    const identified = await service.identify(source); r.identified = true; r.creator = identified.creator;
    const first = await service.page(identified.id, { limit: 3, excludeDownloaded: true }, true); r.listRead = first.items.length > 0; r.status = first.status; r.message = first.message; r.count = first.items.length; r.complete = first.complete; r.items = first.items;
  } catch (e) { r.error = safeLog(e.message); }
  results.push(r);
}
store.close(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ output, results }, null, 2)); console.log(JSON.stringify({ output, results }, null, 2));
