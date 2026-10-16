import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
import {douyinPageState} from '../electron/douyin-page.js';

test('抖音明确服务错误可重连；验证码和登录不能自动处理；页头登录入口不构成拦截',async t=>{
 const browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{channel:'chrome'})});t.after(()=>browser.close());
 const page=await browser.newPage();let body='';await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body}));
 const read=async html=>{body=html;await page.goto('https://www.douyin.com/video/7694416599897985935');return page.evaluate(`(${douyinPageState.toString()})()`);};
 const failed=await read('<h2>服务器出现问题</h2><p>请稍后重试</p>');assert.equal(failed.kind,'service-error');assert.equal(failed.retryable,true);
 const verified=await read('<title>验证码中间页</title>');assert.equal(verified.kind,'verification');assert.equal(verified.retryable,false);
 const loggedOut=await read('<div data-e2e="login-dialog">请扫码登录查看更多</div>');assert.equal(loggedOut.kind,'login');assert.equal(loggedOut.retryable,false);
 const publicPage=await read('<header><button>登录</button></header><div data-e2e="comment-item">公开评论</div>');assert.equal(publicPage.kind,'unconfirmed');
 const quote=await read('<article>评论者说服务器出现问题，但是我已经正常使用。</article>');assert.equal(quote.retryable,false);
 const hidden=await read('<div style="display:none">服务器出现问题</div><div>公开作品</div>');assert.equal(hidden.retryable,false);
 await page.goto('https://example.com/');assert.equal((await page.evaluate(`(${douyinPageState.toString()})()`)).kind,'outside');
});
