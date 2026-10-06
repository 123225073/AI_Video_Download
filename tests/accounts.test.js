import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedCookie, parseCookieFile, cookieDetails, hasBilibiliLoginCookie } from '../electron/account-session.js';
test('账号域名必须属于选定平台，不匹配伪造后缀', () => {
  assert.ok(allowedCookie('B站', { domain: '.passport.bilibili.com' }));
  assert.equal(allowedCookie('B站', { domain: '.bilibili.com.invalid.test' }), false);
  assert.equal(allowedCookie('YouTube', { domain: '.bilibili.com' }), false);
});
test('导入保留 HttpOnly 和会话属性，忽略过期和其他平台 Cookie', () => {
  const text = '# Netscape HTTP Cookie File\n#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tfixture\tsynthetic\n.bilibili.com\tTRUE\t/\tTRUE\t1\texpired\tx\n.google.com\tTRUE\t/\tTRUE\t0\tother\tx';
  const cookies = parseCookieFile(text, 'B站'); assert.equal(cookies.length, 1); assert.ok(cookies[0].httpOnly); assert.equal(cookieDetails(cookies[0]).expirationDate, undefined); assert.equal(cookieDetails(cookies[0]).url, 'https://bilibili.com/');
});
test('错误格式与选错平台明确拒绝', () => {
  assert.throws(() => parseCookieFile('invalid', 'B站'), /格式/);
  assert.throws(() => parseCookieFile('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tfixture\tx', 'B站'), /没有此平台/);
});

test('B站访客Cookie不能当作已登录，登录会话须属于本平台且未过期',()=>{
  const cookie={domain:'.bilibili.com',name:'SESSDATA',value:'SYNTHETIC-ONLY',expirationDate:200};
  assert.equal(hasBilibiliLoginCookie([cookie],100),true);
  for(const invalid of [{...cookie,name:'buvid3'},{...cookie,value:''},{...cookie,expirationDate:50},{...cookie,expirationDate:NaN},{...cookie,domain:'.bilibili.com.evil.example'}])assert.equal(hasBilibiliLoginCookie([invalid],100),false);
});
