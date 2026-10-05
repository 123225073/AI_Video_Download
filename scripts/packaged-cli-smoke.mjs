import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const program = path.resolve(process.argv[2] || 'release/win-unpacked');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const output = path.resolve('output', `packaged-cli-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const profile = path.join(output, '用户数据'), fixture = path.join(output, 'test.mp4');
const executable = path.join(program, 'FengshaVideoDownloader.exe');
const node = path.join(program, 'resources/bin/node/node.exe'), entry = path.join(program, 'resources/cli/fengsha.mjs');
const env = { ...process.env, FENGSHA_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
execFileSync(path.join(program, 'resources/bin/ffmpeg/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '2', '-c:v', 'mpeg4', fixture], { windowsHide: true });
const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(fixture).size }); fs.createReadStream(fixture).pipe(res); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app; const result = { output, ok: false };
function cli(args, cmd = false) {
  return new Promise((resolve, reject) => {
    const commandArgs = [...args, '--data-dir', profile];
    const child = cmd ? spawn('cmd.exe', ['/d', '/s', '/c', `""${path.join(program, 'fengsha-cli.cmd')}" ${commandArgs.map(a => '"' + a + '"').join(' ')}"`], { env, windowsHide: true, windowsVerbatimArguments: true }) : spawn(node, [entry, ...commandArgs], { env, windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d); child.on('error', reject);
    child.on('close', code => { try { assert.equal(code, 0, stdout + stderr); resolve(JSON.parse(stdout)); } catch (e) { reject(e); } });
  });
}
try {
  assert.equal((await cli(['version'])).data.version, version); result.bundledNode = true;
  assert.equal((await cli(['version'], true)).data.version, version); result.cmdEntry = true;
  const environment = await cli(['environment']); assert.equal(environment.data.components.length, 4); assert.ok(environment.data.components.every(c => c.ok)); result.components = true;
  const url = `http://127.0.0.1:${server.address().port}/video.mp4`;
  const inspection = await cli(['inspect', url]); assert.equal(inspection.data.items.length, 1);
  const downloaded = await cli(['download', url, '--output', path.join(output, '下载视频'), '--archive', 'flat', '--timeout', '60']);
  const file = downloaded.data.files[0].filePath; assert.ok(fs.existsSync(file)); result.realDownload = true;
  assert.ok((await cli(['probe', '--file', file])).data.duration > 0); result.probe = true;
  await cli(['service', 'stop']); await new Promise(r => setTimeout(r, 1500));
  app = await electron.launch({ executablePath: executable, args: ['--agent-data-dir', profile], env, timeout: 45000 });
  const page = await app.firstWindow(); await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  const snapshot = (await page.evaluate(() => window.fengsha.snapshot())).value;
  assert.equal(snapshot.version, version); assert.equal(snapshot.media.length, 1); assert.equal(snapshot.tasks[0].status, 'completed'); result.guiDataRetained = true;
  const service = await cli(['service']); assert.equal(service.data.background, false); result.reusesGUI = true;
  const help = fs.readFileSync(path.join(program, 'resources/使用说明.md'), 'utf8');
  for (const match of help.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(program, 'resources', match[1])), match[1]);
  assert.ok(fs.existsSync(path.join(program, 'resources/CLI使用说明.md'))); result.illustratedHelp = true;
  await page.screenshot({ path: path.join(output, 'packaged-window.png') }); result.ok = true;
} catch (e) { result.error = String(e.stack || e); process.exitCode = 1; }
finally { if (app) await app.close(); else await cli(['service', 'stop']).catch(() => {}); server.close(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
