import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const sourceHelper = path.resolve('scripts/clash-route-helper.mjs');
function childRun(helper, args, chunks = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    for (const chunk of chunks) child.stdin.write(chunk);
    child.stdin.end();
  });
}
test('restore helper accepts bounded stdin in real source and production-bundle child processes', { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengsha-helper-中文-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundled = await build({ entryPoints: [sourceHelper], bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false });
  const bundleHelper = path.join(directory, 'helper.cjs');
  fs.writeFileSync(bundleHelper, bundled.outputFiles[0].contents);
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    assert.equal(req.headers.authorization, 'Bearer fixture-private-token');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ rules: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // Only an ephemeral fixture controller is reachable; no real Clash address.
  fs.writeFileSync(path.join(directory, 'clash-verge.yaml'), JSON.stringify({
    'external-controller': `127.0.0.1:${server.address().port}`, secret: 'fixture-private-token'
  }));
  const state = { schema: 1, mode: 'routed', routing: { directory }, privateMarker: 'fixture-do-not-print' };
  for (const helper of [sourceHelper, bundleHelper]) {
    const label = helper === sourceHelper ? 'source' : 'bundle';
    await t.test(`${label}: stdin UTF8 split across chunks restores without reading a lease path`, async () => {
      calls.length = 0;
      const bytes = Buffer.from(JSON.stringify(state));
      const chinese = bytes.indexOf(Buffer.from('中文'));
      const result = await childRun(helper, ['--stdin'], [bytes.subarray(0, chinese + 1), bytes.subarray(chinese + 1), '\r\n']);
      assert.equal(result.code, 0, `safe child stderr: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { restored: true });
      assert.equal(result.stderr, '');
      assert.deepEqual(calls, [{ method: 'GET', url: '/rules' }]);
    });
    await t.test(`${label}: legacy file-path CLI remains compatible`, async () => {
      const lease = path.join(directory, 'fixture-lease.json');
      fs.writeFileSync(lease, JSON.stringify(state));
      const result = await childRun(helper, [lease]);
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), { restored: true });
      assert.equal(result.stderr, '');
    });
    await t.test(`${label}: invalid input fails before controller access and exposes only a safe stage`, async () => {
      for (const [payload, stage] of [
        ['', 'lease-parse'], ['%TSD-Header-fixture-do-not-print', 'lease-parse'], ['{"fixture-do-not-print":', 'lease-parse'],
        ['null', 'lease-validate'], ['[]', 'lease-validate'],
        [JSON.stringify({ ...state, schema: 2 }), 'lease-validate'],
        [JSON.stringify({ ...state, mode: 'system' }), 'lease-validate'],
        [JSON.stringify({ ...state, routing: {} }), 'lease-validate'],
        [JSON.stringify({ ...state, routing: { directory: '   ' } }), 'lease-validate'],
        [JSON.stringify({ ...state, routing: { directory: 42 } }), 'lease-validate'],
        [JSON.stringify({ ...state, padding: 'x'.repeat(1024 * 1024) }), 'lease-size']
      ]) {
        calls.length = 0;
        const result = await childRun(helper, ['--stdin'], [payload]);
        assert.equal(result.code, 1);
        assert.deepEqual(JSON.parse(result.stdout), { restored: false, stage });
        assert.equal(result.stderr, '');
        assert.doesNotMatch(result.stdout, /fixture-do-not-print|fixture-private-token/);
        assert.deepEqual(calls, [], 'invalid input must not reach even the fixture controller');
      }
    });
    await t.test(`${label}: restoration failure is distinguishable from JSON parsing without printing paths`, async () => {
      const result = await childRun(helper, ['--stdin'], [JSON.stringify({ ...state, routing: { directory: path.join(directory, 'missing') } })]);
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), { restored: false, stage: 'route-restore' });
      assert.equal(result.stderr, '');
    });
  }
});
