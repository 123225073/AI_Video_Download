import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url), root = path.resolve('.');
const output = path.resolve('output', `douyin-public-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: path.join(output, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
const source = process.argv[2] || 'https://www.douyin.com/video/6961737553342991651';
let application; const result = { output, source, guestSession: true, ok: false };
try {
  application = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 45000 });
  await (await application.firstWindow()).getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  result.identity = await application.evaluate(async (_, url) => {
    const reader = globalThis.fengshaTest.creators.browser;
    try {
      const creator = await reader.identify(url, '抖音', null, new AbortController().signal);
      const list = await reader.page(creator, 5, new AbortController().signal);
      return { creator, list };
    } catch (error) {
      const window = reader.window;
      return { error: error.message, url: window?.webContents.getURL(), page: window && !window.isDestroyed() ? await window.webContents.executeJavaScript('({title:document.title,text:document.body.innerText.slice(0,300),authorPanels:[...document.querySelectorAll("[data-e2e=user-info]")].map(p=>({text:p.innerText,links:[...p.querySelectorAll("a[href]")].map(a=>({url:a.href,text:a.innerText,title:a.title}))})),roles:[...document.querySelectorAll("[data-e2e]")].map(x=>x.getAttribute("data-e2e")).filter(x=>/user|author|post/.test(x)).slice(0,25)})') : null };
    }
  }, source);
  for (const window of application.windows()) { if ((await window.url()).includes('douyin.com')) await window.screenshot({ path: path.join(output, '抖音官方页面.png') }); }
  result.ok = Boolean(result.identity.creator && result.identity.list.items.length);
  if (result.ok && process.argv.includes('--download')) {
    result.download = await application.evaluate(async (_, { directory, source }) => {
      const t = globalThis.fengshaTest, signal = AbortSignal.timeout(120000);
      try {
        const parsed = await t.engine.parse(source, { signal });
        const file = await t.engine.download({ id: 'public-douyin-smoke', item: parsed.items[0], options: { quality: 'best' } }, directory, signal, () => {});
        return { ok: true, ...file };
      } catch (error) { return { ok: false, error: error.message }; }
    }, { directory: path.join(output, 'download'), source });
    result.ok = result.download.ok;
  }
  if (!result.ok) process.exitCode = 1;
} finally { await application?.close().catch(() => {}); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
