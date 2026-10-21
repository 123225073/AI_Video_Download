import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CollectorConnection} from '../electron/collector-connection.js';

function fixture() {
  const directory=path.resolve('output/unit-startup-recovery',randomUUID());
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'lease-startup.json'),JSON.stringify({phase:'applying'}));
  let release,reject,entered;
  const waiting=new Promise(resolve=>entered=resolve),pending=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
  const calls=[],states=[],store={get:()=>null};
  const connection=new CollectorConnection(store,'',directory,()=>states.push(connection.state.phase),{
    system:async action=>{calls.push(action);entered();await pending;return {};}
  });
  connection.prepareComponent=async()=>{calls.push('prepare');return connection.status();};
  return {connection,calls,states,waiting,release:()=>release(),reject:error=>reject(error)};
}

test('启动恢复立即成为共享屏障；并发检查只恢复一次，准备在恢复完成后开始',async()=>{
  const x=fixture(),first=x.connection.recover(),second=x.connection.recover();
  const preparation=x.connection.prepare();
  await x.waiting;
  assert.equal(first,second);
  assert.equal(x.connection.status().phase,'recovering');
  assert.deepEqual(x.calls,['restore']);
  x.release();await Promise.all([first,second,preparation]);
  assert.deepEqual(x.calls,['restore','prepare']);
  assert.equal(x.connection.recovering,null);
});

test('等待启动恢复时取消单个视频号任务，不取消恢复，也不迟到启动任务',async()=>{
  const x=fixture(),recovery=x.connection.recover(),controller=new AbortController();
  x.connection.config=()=>({automatic:false,enabled:true});
  const run=x.connection.withConnection(controller.signal,async()=>x.calls.push('operation'));
  await x.waiting;controller.abort();await assert.rejects(run,/CANCELLED/);
  assert.deepEqual(x.calls,['restore']);
  x.release();await recovery;await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(x.calls,['restore']);
  assert.equal(x.connection.status().phase,'idle');
});

test('启动恢复失败保持错误状态，并阻止准备与新租约；明确恢复成功后可再准备',async()=>{
  const x=fixture(),recovery=x.connection.recover(),preparation=x.connection.prepare();
  const errors=Promise.allSettled([recovery,preparation]);
  await x.waiting;x.reject(Error('原网络恢复失败'));
  const results=await errors;
  assert.ok(results.every(result=>result.status==='rejected'));
  assert.equal(x.connection.status().phase,'error');
  assert.match(x.connection.status().label,/原网络恢复失败/);
  await assert.rejects(x.connection.prepare(),/恢复/);
  await assert.rejects(x.connection.withConnection(undefined,async()=>x.calls.push('operation')),/恢复/);
  assert.deepEqual(x.calls,['restore']);
  x.connection.system=async action=>x.calls.push(action);
  await x.connection.restore();await x.connection.prepare();
  assert.deepEqual(x.calls,['restore','restore','prepare']);
});

test('退出等待已开始的网络恢复；准备调用不在退出后启动组件',async()=>{
  const x=fixture(),recovery=x.connection.recover(),preparation=x.connection.prepare();
  const prepareResult=Promise.allSettled([preparation]);
  await x.waiting;let closed=false;
  const closing=x.connection.close().then(()=>closed=true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false);
  x.release();await Promise.all([recovery,closing]);
  assert.equal((await prepareResult)[0].status,'rejected');
  assert.deepEqual(x.calls,['restore']);
  assert.equal(closed,true);
});

test('退出期间恢复失败不会误清错误，也不提前终止仍可能承载临时代理的组件',async()=>{
  const x=fixture(),recovery=x.connection.recover();let killed=0;
  x.connection.worker={kill(){killed++;}};
  const closing=x.connection.close(),results=Promise.allSettled([recovery,closing]);
  await x.waiting;x.reject(Error('原网络恢复失败'));
  assert.ok((await results).every(result=>result.status==='rejected'));
  assert.equal(x.connection.status().phase,'error');assert.equal(killed,0);
});

test('启动恢复已经失败后退出仍保留未恢复状态，不把空闲收尾当作恢复成功',async()=>{
  const x=fixture(),recovery=x.connection.recover(),result=Promise.allSettled([recovery]);
  await x.waiting;x.reject(Error('原网络恢复失败'));await result;
  await assert.rejects(x.connection.close(),/恢复失败/);
  assert.equal(x.connection.status().phase,'error');
});
