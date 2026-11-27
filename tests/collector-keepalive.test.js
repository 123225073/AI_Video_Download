import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CollectorConnection } from '../electron/collector-connection.js';

const proxy = {
  ProxyEnable: { present: true, value: 1 },
  ProxyServer: { present: true, value: '127.0.0.1:7897' },
  ProxyOverride: { present: false, value: null },
  AutoConfigURL: { present: false, value: null },
};

function makeFixture({ routed = true, keepAliveMs = 150 } = {}) {
  const data = new Map();
  const store = {
    get: (type, id) => data.get(`${type}:${id}`),
    put: (type, id, value) => data.set(`${type}:${id}`, value),
    flush() {},
  };
  store.put('collector-policy', 'automatic', { allowed: true, certificateFingerprint: 'unit' });
  const events = [];
  let applied = false, online = true;
  const dir = path.resolve('output/unit-connection', `keepalive-${randomUUID()}`);
  const routing = routed
    ? {
        discover: async () => ({ directory: 'clash-dir', configurationDigest: 'd1', rulesDigest: 'r1', ruleCount: 2 }),
        begin: async () => { events.push('route-begin'); },
      }
    : { discover: async () => null };
  const conn = new CollectorConnection(store, '', dir, () => {}, {
    waitMs: 50,
    keepAliveMs,
    routing,
    guard: async () => events.push('guard'),
    system: async action => {
      events.push(action);
      if (action === 'apply') applied = true;
      if (action === 'restore') applied = false;
      if (action === 'inspect') {
        return {
          proxy: !routed && applied ? { ...proxy, ProxyServer: { present: true, value: '127.0.0.1:2023' } } : proxy,
          ownerStarted: 'fixture',
        };
      }
      return {};
    },
  });
  conn.prepare = async () => { conn.certificate = { name: 'Fengsha-WeChat-unit', fingerprint: 'unit', file: 'fixture' }; };
  conn.online = async () => online;
  conn.adapterReady = async () => true;
  conn.api = async () => ({});
  conn.stopProxy = async () => events.push('stop-proxy');
  return { conn, store, events, setOnline: v => { online = v; } };
}

test('Clash 分流保活模式：连续多次任务共享同一租约免重连，空闲超时后自动恢复原网络', async () => {
  const { conn, events } = makeFixture({ routed: true, keepAliveMs: 120 });
  await conn.withConnection(undefined, async () => { events.push('task-1'); });
  assert.equal(conn.status().keepAliveActive, true);
  assert.equal(events.filter(e => e === 'apply').length, 1);
  assert.equal(events.filter(e => e === 'restore').length, 0);

  // Second task reuses the exact same routed lease with zero re-apply!
  await conn.withConnection(undefined, async () => { events.push('task-2'); });
  assert.equal(events.filter(e => e === 'apply').length, 1);
  assert.equal(events.filter(e => e === 'route-begin').length, 1);
  assert.equal(events.filter(e => e === 'restore').length, 0);

  // After idle timeout, connection restores cleanly.
  await new Promise(r => setTimeout(r, 220));
  assert.equal(conn.status().keepAliveActive, false);
  assert.equal(events.filter(e => e === 'restore').length, 1);
  assert.equal(events.filter(e => e === 'stop-proxy').length, 1);
});

test('保活期间任务失败、关闭应用或手动恢复均立即清理并恢复原网络', async () => {
  const f1 = makeFixture({ routed: true, keepAliveMs: 60000 });
  await f1.conn.withConnection(undefined, async () => {});
  assert.equal(f1.conn.status().keepAliveActive, true);
  await f1.conn.close();
  assert.equal(f1.conn.status().keepAliveActive, false);
  assert.equal(f1.events.filter(e => e === 'restore').length, 1);

  const f2 = makeFixture({ routed: true, keepAliveMs: 60000 });
  await assert.rejects(f2.conn.withConnection(undefined, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(f2.conn.status().keepAliveActive, false);
  assert.equal(f2.events.filter(e => e === 'restore').length, 1);
});

test('非 Clash 分流（系统代理）模式绝不保活，任务结束后立即恢复系统代理', async () => {
  const { conn, events } = makeFixture({ routed: false, keepAliveMs: 60000 });
  await conn.withConnection(undefined, async () => {});
  assert.equal(conn.status().keepAliveActive, false);
  assert.equal(events.filter(e => e === 'restore').length, 1);
});
