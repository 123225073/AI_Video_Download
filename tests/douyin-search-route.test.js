import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {contentNavigation} from '../electron/content-navigation.js';
const source=fs.readFileSync(new URL('../electron/content-browser.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('export function renderedContent'),source.indexOf('export class ContentBrowser')).replace('export function','function');
const search=source.slice(source.indexOf('export function contentSearchURL'),source.indexOf('// Only fields')).replace('export function','function');
function rendered(url,keyword='AI'){
 const context={URL,location:{href:url},document:{title:'发现更多精彩视频 - 抖音搜索',body:{innerText:''},querySelectorAll:()=>[]},getComputedStyle:()=>({visibility:'visible'})};
 return vm.runInNewContext(fn+';renderedContent("抖音",'+JSON.stringify(keyword)+')',context);
}
test('new searches use the successful official GUI jingxuan general route',()=>{
 const result=vm.runInNewContext(search+';contentSearchURL("抖音","AI 视频")',{Date});
 const u=new URL(result);assert.equal(u.origin,'https://www.douyin.com');assert.equal(decodeURIComponent(u.pathname),'/jingxuan/search/AI 视频');assert.equal(u.searchParams.get('type'),'general');
});
test('same-keyword official jingxuan search is readable before and after its category parameter appears',()=>{
 for(const suffix of ['', '?type=general','?type=video','/?type=general'])assert.equal(rendered('https://www.douyin.com/jingxuan/search/AI'+suffix).blocked,undefined,suffix);
 assert.equal(rendered('https://www.douyin.com/jingxuan/search/AI%20%E8%A7%86%E9%A2%91?type=general','AI 视频').blocked,undefined);
});
test('legacy video search keeps compatibility but unrelated keywords and categories cannot leak into a task',()=>{
 assert.equal(rendered('https://www.douyin.com/search/AI?type=video').blocked,undefined);
 for(const url of ['https://www.douyin.com/jingxuan/search/other?type=general','https://www.douyin.com/jingxuan/search/AI?type=user','https://www.douyin.com/jingxuan/search/AI?type=live','https://www.douyin.com.evil.invalid/jingxuan/search/AI?type=general','https://www.douyin.com/jingxuan/search/%E0%A4%A'])assert.equal(rendered(url).blocked,true,url);
});
test('new route remains inside the existing official navigation boundary',()=>{
 const initial='https://www.douyin.com/';
 assert.equal(contentNavigation('https://www.douyin.com/jingxuan/search/AI?type=general',initial,'抖音').allowed,true);
 assert.equal(contentNavigation('https://www.douyin.com.evil.invalid/jingxuan/search/AI',initial,'抖音').allowed,false);
});
