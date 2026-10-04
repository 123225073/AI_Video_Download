import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Store } from '../electron/store.js';
import { Transcriptions } from '../electron/transcription.js';
const dir = path.resolve('output', `asr-smoke-${Date.now()}`); fs.mkdirSync(dir, { recursive: true });
const store = await Store.open(path.join(dir, 'profile'), {}); let calls = 0;
const ai = { config: kind => kind === 'speech' ? { mode: 'local', localModel: 'base', language: 'zh' } : { hasKey: true, model: 'must-not-run-on-silence', chunkChars: 10000 }, chat: async () => { calls++; return 'not expected'; } };
const service = new Transcriptions(store, { bin: path.resolve(process.argv[2] || 'bin') }, ai, dir, () => {});
const signal = new AbortController().signal; const results = {};
try {
  for (const model of ['base', 'small']) { const t = await service.localSpeech(path.resolve('output/reference/speech-fixture.wav'), model, 'zh', signal, () => {}); assert.match(t.text, /视频|文字|观点|知识/); assert.ok(t.segments.length); results[model] = t; }
  const silence = path.join(dir, 'silence.wav'); execFileSync(path.resolve('bin/ffmpeg/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '8', silence], { windowsHide: true }); const id = service.start({ inputId: service.choose(silence).id }).id;
  while (service.active || service.get(id).status === 'queued') await new Promise(r => setTimeout(r, 100)); assert.equal(service.get(id).status, 'no-speech'); assert.equal(calls, 0); results.silenceNoAI = true; results.ok = true;
} catch (e) { results.ok = false; results.error = String(e.stack || e); process.exitCode = 1; }
finally { await service.close(); store.close(); fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify({ output: dir, ...results }, null, 2)); }
