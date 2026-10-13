import test from 'node:test';import assert from 'node:assert/strict';import {routedConfig,routeRule,routeName,proxyName,ClashRoute,rulesEquivalent,parseClashConfig} from '../electron/clash-route.js';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
test('配置解析和接口 JSON 失败不在错误中回显控制密钥',async()=>{const dir=path.resolve('output/clash-route-unit',randomUUID());fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'clash-verge.yaml'),'secret: [private-token\n');assert.throws(()=>new ClashRoute(dir).load(),e=>!e.message.includes('private-token'));const route=new ClashRoute('',async()=>new Response('private-token',{status:200}));await assert.rejects(route.api({base:'http://127.0.0.1:1',secret:'private-token'},'/configs'),e=>!e.message.includes('private-token'));});
test('同数量但不同规则/被手动禁用的运行配置不能被覆盖',()=>{const source=['DOMAIN-SUFFIX,example.com,original','IP-CIDR,127.0.0.0/8,DIRECT,no-resolve','MATCH,original'];const actual=[{type:'DomainSuffix',payload:'example.com',proxy:'original'},{type:'IPCIDR',payload:'127.0.0.0/8',proxy:'DIRECT'},{type:'Match',payload:'',proxy:'original'}];assert.equal(rulesEquivalent(source,actual),true);assert.equal(rulesEquivalent(source,[{...actual[0],payload:'different.com'},...actual.slice(1)]),false);assert.equal(rulesEquivalent(source,[{...actual[0],extra:{disabled:true}},...actual.slice(1)]),false);});
test('真实 Mihomo 的 IPv6、resolve 与逻辑规则格式保持语义，不混淆 AND/OR',()=>{const source=['IP-CIDR6,::1/128,DIRECT,no-resolve','GEOIP,cn,DIRECT,resolve','AND,((DST-PORT,443),(NETWORK,UDP)),REJECT'];const actual=[{type:'IPCIDR',payload:'::1/128',proxy:'DIRECT'},{type:'GeoIP',payload:'cn',proxy:'DIRECT'},{type:'AND',payload:'((DstPort,443) && (Network,udp))',proxy:'REJECT'}];assert.equal(rulesEquivalent(source,actual),true);assert.equal(rulesEquivalent(source,[...actual.slice(0,2),{...actual[2],payload:'((DstPort,443) || (Network,udp))'}]),false);});
const configuration=()=>({mode:'rule','mixed-port':7897,secret:'private-token',dns:{enable:true},proxies:[{name:'existing',type:'http',server:'example.com',port:80}], 'proxy-groups':[{name:'original',type:'select',proxies:['existing','DIRECT']}],rules:['DOMAIN,example.com,original','MATCH,DIRECT']});
test('临时分流序列化保留形似科学计数和前导零的 REALITY ID，不改变端口类型',()=>{
 const c=parseClashConfig('mixed-port: 7897\nsecret: 00123\nproxies:\n  - name: fixture\n    type: vless\n    port: 443\n    reality-opts:\n      short-id: 123e4567\n');
 assert.equal(c.proxies[0]['reality-opts']['short-id'],'123e4567');assert.equal(c.secret,'00123');
 assert.equal(c['mixed-port'],7897);assert.equal(c.proxies[0].port,443);
 assert.equal(parseClashConfig('proxies: [{reality-opts: {short-id: 00112233}}]').proxies[0]['reality-opts']['short-id'],'00112233');
});
test('文本化保留空值和别名原词法，不能改变别名其他数值用途',()=>{
 for(const raw of ['null','~',''])assert.equal(parseClashConfig('secret: '+raw+'\n').secret,null);
 const c=parseClashConfig('sid: &sid 00112233\nproxies: [{reality-opts: {short-id: *sid}}]');
 assert.equal(c.sid,112233);assert.equal(c.proxies[0]['reality-opts']['short-id'],'00112233');
 assert.equal(parseClashConfig('secret: "null"').secret,'null');
});
test('复合规则子项同样按 IDNA 和国家代码比较，并保持 AND/OR 不同',()=>{
 const configured=['AND,((DOMAIN-SUFFIX,smartdns良心云.com),(GEOIP,CN)),DIRECT'];
 const a={type:'AND',payload:'((DomainSuffix,xn--smartdns-i30m433luy5e.com) && (GeoIP,cn))',proxy:'DIRECT'};
 assert.equal(rulesEquivalent(configured,[a]),true);assert.equal(rulesEquivalent(configured,[{...a,payload:a.payload.replace('&&','||')}]),false);
});
test('Mihomo 的国际化域名和国家代码规范化不会误报临时规则冲突',()=>{
 const configured=['DOMAIN-SUFFIX,smartdns良心云.com,DIRECT','GEOIP,CN,DIRECT','MATCH,DIRECT'];
 const actual=[{type:'DomainSuffix',payload:'xn--smartdns-i30m433luy5e.com',proxy:'DIRECT'},{type:'GeoIP',payload:'cn',proxy:'DIRECT'},{type:'Match',payload:'',proxy:'DIRECT'}];
 assert.equal(rulesEquivalent(configured,actual),true);
 assert.equal(rulesEquivalent(configured,[{...actual[0],payload:'different.com'},...actual.slice(1)]),false);
 assert.equal(rulesEquivalent(configured,[actual[0],{...actual[1],proxy:'other'},actual[2]]),false);
 assert.equal(rulesEquivalent(configured,[actual[0],{...actual[1],extra:{disabled:true}},actual[2]]),false);
});
test('分流仅增加视频号规则，原节点、DNS、密钥和端口不变，采集器不向 Clash 回环',()=>{const c=configuration(),original=structuredClone(c),r=routedConfig(c,{mode:'rule','mixed-port':7897});assert.deepEqual(c,original);assert.deepEqual(r.rules,[routeRule,...c.rules]);assert.deepEqual(r.proxies.slice(0,-1),c.proxies);assert.deepEqual(r['proxy-groups'].slice(0,-1),c['proxy-groups']);assert.deepEqual(r.dns,c.dns);assert.equal(r.secret,c.secret);assert.deepEqual(r['proxy-groups'].at(-1).proxies,[proxyName,'DIRECT']);assert.equal(r['proxy-groups'].at(-1).name,routeName);assert.equal(r['mixed-port'],7897);});
test('全局/直连模式与名称冲突不覆盖现有配置',()=>{for(const mode of ['global','direct'])assert.throws(()=>routedConfig(configuration(),{mode}));const c=configuration();c.proxies.push({name:proxyName});assert.throws(()=>routedConfig(c,{mode:'rule'}));});
test('不把本机控制接口凭据或服务器错误返回给界面',async()=>{const route=new ClashRoute('',async()=>new Response('private-token private-server',{status:400}));await assert.rejects(route.api({base:'http://127.0.0.1:1',secret:'private-token'},'/configs'),e=>!e.message.includes('private-token')&&!e.message.includes('private-server'));});
