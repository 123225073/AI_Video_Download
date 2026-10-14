import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const windows = process.platform === 'win32';
const systemScript = path.resolve('electron/collector-system.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengsha-system-中文-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = { schema: 1, id: randomUUID(), phase: 'active', mode: 'routed',
    proxyAddress: '127.0.0.1:2023', certificateName: 'Fengsha-WeChat-fixture', certificateAdded: false,
    routing: { directory }, privateMarker: 'fixture-do-not-print', certificateFile: 'fixture-private-path' };
  const stateFile = path.join(directory, 'fixture-lease.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const psScript = path.join(directory, 'collector-system.ps1');
  // Production preparation also supplies a BOM for Windows PowerShell 5.1.
  fs.writeFileSync(psScript, '\uFEFF' + fs.readFileSync(systemScript, 'utf8').replace(/^\uFEFF/, ''));
  return { directory, state, stateFile, psScript };
}
test('PowerShell state-status validates owned lease and returns only phase/mode without writing', { skip: !windows }, async t => {
  const { state, stateFile, psScript } = fixture(t);
  const original = fs.readFileSync(stateFile), modified = fs.statSync(stateFile).mtimeMs;
  const result = await run(['-File', psScript, '-Action', 'state-status', '-StateFile', stateFile]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { phase: 'active', mode: 'routed' });
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /fixture-do-not-print|fixture-private-path/);
  assert.deepEqual(fs.readFileSync(stateFile), original);
  assert.equal(fs.statSync(stateFile).mtimeMs, modified);
  for (const patch of [{ schema: 2 }, { proxyAddress: '127.0.0.1:9999' }, { certificateName: 'Unrelated-root' }]) {
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, ...patch }));
    const invalid = await run(['-File', psScript, '-Action', 'state-status', '-StateFile', stateFile]);
    assert.equal(invalid.code, 1);
    const reply = JSON.parse(invalid.stdout);
    assert.equal(reply.ok, false);assert.equal(reply.stage, 'state-status');
    assert.equal(reply.phase, undefined);assert.equal(reply.mode, undefined);
    assert.doesNotMatch(invalid.stdout, /fixture-do-not-print|fixture-private-path|Unrelated-root/);
    assert.equal(invalid.stderr, '');
  }
});

test('PowerShell Restore-State pipes its decoded state to the actual bundled helper in UTF8', { skip: !windows, timeout: 60000 }, async t => {
  const { directory, stateFile } = fixture(t);
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');assert.equal(req.url, '/rules');
    res.setHeader('Content-Type', 'application/json');res.end('{"rules":[]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(directory, 'clash-verge.yaml'), JSON.stringify({ 'external-controller': `127.0.0.1:${server.address().port}` }));
  const bundled = await build({ entryPoints: ['scripts/clash-route-helper.mjs'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false });
  const helper = path.join(directory, 'helper.cjs');fs.writeFileSync(helper, bundled.outputFiles[0].contents);
  // Execute production function bodies from the PS AST. Only external system
  // changes and protected-reader behavior are replaced by fixture seams.
  const command = `
    $ErrorActionPreference='Stop'
    trap { @{ok=$false;stage=$script:taskStage;exceptionType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress; exit 1 }
    $script:taskStage='fixture-ast'
    $tokens=$null;$errors=$null
    $source=Get-Content -LiteralPath ${psQuote(systemScript)} -Raw -Encoding UTF8
    $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
    foreach($name in @('Read-State','Restore-State')) {
      $definition=$ast.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name},$true) | Select-Object -First 1
      Invoke-Expression $definition.Extent.Text
    }
    $StateFile=${psQuote(stateFile)}
    $script:taskStage='fixture-read'
    $script:decodedFixture=Read-State
    [IO.File]::WriteAllText($StateFile,'%TSD-Header-fixture-unreadable-by-node')
    function Read-State { return $script:decodedFixture }
    function Split-Path { param($Path,[switch]$Parent) return ${psQuote(directory)} }
    function Join-Path { param($Path,$ChildPath)
      if($ChildPath -eq 'node/node.exe'){return ${psQuote(process.execPath)}}
      if($ChildPath -eq 'clash-route-helper.cjs'){return ${psQuote(helper)}}
      return Microsoft.PowerShell.Management\Join-Path $Path $ChildPath
    }
    function Read-Proxy { return @{} }
    $script:proxyCalls=@()
    function Invoke-RestMethod { param($Uri,$Method,$ContentType,$Body,$TimeoutSec)
      $script:proxyCalls+=@{uri=$Uri;method=$Method;body=($Body|ConvertFrom-Json)}
    }
    function Notify-Proxy { throw 'Real proxy forbidden in fixture' }
    function Open-Root { throw 'Real certificate store forbidden in fixture' }
    function Save-State($value) { $script:savedPhase=$value.phase }
    $result=Restore-State
    @{restored=($result.phase -eq 'restored');savedPhase=$script:savedPhase;proxyCalls=$script:proxyCalls} | ConvertTo-Json -Depth 6 -Compress
  `;
  const harness = path.join(directory, 'restore-fixture.ps1');
  fs.writeFileSync(harness, '\uFEFF' + command);
  const result = await run(['-File', harness]);
  assert.equal(result.code, 0, `safe PS failure: ${result.stdout}`);
  assert.deepEqual(JSON.parse(result.stdout), { restored: true, savedPhase: 'restored',proxyCalls:[
    {uri:'http://127.0.0.1:2022/api/proxy/config',method:'Post',body:{values:{'proxy.enabled':false,'proxy.system':false},restart:false}},
    {uri:'http://127.0.0.1:2022/api/service/stop',method:'Post',body:{name:'interceptor'}}
  ] });
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /fixture-do-not-print|fixture-private-path/);
  assert.match(fs.readFileSync(stateFile, 'utf8'), /^%TSD-Header/,'helper did not repair or copy the protected lease');
});
