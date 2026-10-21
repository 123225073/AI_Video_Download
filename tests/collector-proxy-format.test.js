import test from 'node:test';
import assert from 'node:assert/strict';
import {upstreamProxy} from '../electron/collector-connection.js';

const proxy=value=>({ProxyEnable:{value:1},ProxyServer:{value}});

test('Windows的HTTP和HTTPS等价代理映射可自动连接',()=>{
  assert.equal(upstreamProxy(proxy('http=127.0.0.1:7897;https=127.0.0.1:7897')),'http://127.0.0.1:7897');
  assert.equal(upstreamProxy(proxy('http=localhost:8080; https=localhost:8080;')),'http://localhost:8080');
  assert.equal(upstreamProxy(proxy('https=[::1]:7897;http=[0:0:0:0:0:0:0:1]:7897')),'http://[::1]:7897');
});

test('分协议代理不等价或缺失HTTP/HTTPS时保留原网络，不扩大直连或代理范围',()=>{
  for(const value of ['http=localhost:8080','https=localhost:8080','http=localhost:8080;https=localhost:8081','ftp=localhost:8080;http=localhost:8081','http=localhost:8080;socks=localhost:1080'])assert.throws(()=>upstreamProxy(proxy(value)),/分协议代理.*不能安全/);
});

test('单代理端点支持有效IPv6，端口只接受1到65535',()=>{
  assert.equal(upstreamProxy(proxy('[::1]:7897')),'http://[::1]:7897');
  assert.equal(upstreamProxy(proxy('[2001:db8::1]:65535')),'http://[2001:db8::1]:65535');
  assert.equal(upstreamProxy(proxy('proxy.example:1')),'http://proxy.example:1');
  for(const value of ['localhost:0','localhost:65536','127.0.0.1:70000','[::1]:99999','[bad:ipv6]:8080','999.999.999.999:8080'])assert.throws(()=>upstreamProxy(proxy(value)),/代理/);
});

test('代理不接受凭据、路径、协议、重复HTTPS映射或采集自身回环',()=>{
  for(const value of ['user:password@localhost:8080','localhost:8080/path','http://localhost:8080','localhost:8080?token=secret','https=localhost:8080;https=localhost:8081','127.0.0.1:2023','localhost:2023','[::1]:2023'])assert.throws(()=>upstreamProxy(proxy(value)),/代理/);
});

test('仍保留PAC和代理守卫边界，未启用系统代理不使用旧地址',()=>{
  assert.throws(()=>upstreamProxy({...proxy('127.0.0.1:7897'),AutoConfigURL:{value:'https://example.test/proxy.pac'}}),/自动代理脚本/);
  assert.throws(()=>upstreamProxy(proxy('https=127.0.0.1:7897'),true),/系统代理守卫/);
  assert.equal(upstreamProxy({...proxy('127.0.0.1:70000'),ProxyEnable:{value:0}}),'');
});
