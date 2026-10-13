import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {parseClashConfig,rulesEquivalent} from '../electron/clash-route.js';

test('final: null, quoted null, alias lexical values and numeric anchor uses survive roundtrip',()=>{
  for(const raw of ['null','~',''])assert.equal(YAML.parse(YAML.stringify(parseClashConfig('secret: '+raw+'\n'))).secret,null);
  assert.equal(YAML.parse(YAML.stringify(parseClashConfig('secret: "null"'))).secret,'null');
  const c=YAML.parse(YAML.stringify(parseClashConfig('sid: &sid 00112233\ncount: *sid\nproxies: [{reality-opts: {short-id: *sid}}]')));
  assert.equal(c.sid,112233);assert.equal(c.count,112233);assert.equal(c.proxies[0]['reality-opts']['short-id'],'00112233');
});

test('final: lexical conversion preserves anchors defined on text fields',()=>{
  const c=parseClashConfig('password: &pw 00123\nproxies: [{password: *pw}]');
  assert.equal(c.password,'00123');assert.equal(c.proxies[0].password,'00123');
  const roundtrip=YAML.parse(YAML.stringify(c));assert.deepEqual(roundtrip,c);
});

test('final: nested logical canonicalization keeps semantic rejection boundaries',()=>{
  const source=['AND,((OR,((DOMAIN-SUFFIX,smartdns良心云.com),(GEOIP,CN))),(NETWORK,UDP)),DIRECT'];
  const rule={type:'AND',payload:'(((DomainSuffix,xn--smartdns-i30m433luy5e.com) || (GeoIP,cn)) && (Network,udp))',proxy:'DIRECT'};
  assert.equal(rulesEquivalent(source,[rule]),true);
  for(const bad of [{...rule,proxy:'REJECT'},{...rule,extra:{disabled:true}},{...rule,payload:rule.payload.replace('cn','us')},{...rule,payload:rule.payload.replace('&&','||')}])assert.equal(rulesEquivalent(source,[bad]),false);
});
