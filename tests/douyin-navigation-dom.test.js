import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {douyinVisibleAction,douyinVisibleState} from '../electron/douyin-navigation.js';
const id='7695717380512599330';
const node=(text='',extra={})=>({innerText:text,children:[],getClientRects:()=>[1],closest:()=>null,scrollIntoView(){this.scrolled=true;},getBoundingClientRect:()=>({left:10,top:20,width:100,height:40}),...extra});
function action(groups,payload={id,title:'唯一真实标题'}){
 const document={querySelectorAll:s=>groups[s]||[]},location=new URL('https://www.douyin.com/jingxuan/search/AI?type=general');
 return vm.runInNewContext(`(${douyinVisibleAction.toString()})('work',${JSON.stringify(payload)})`,{document,location,URL,getComputedStyle:()=>({visibility:'visible',display:'block'})});
}
test('modern general-search div title opens only an exact unique visible title without relying on hashed classes',()=>{
 const actual=node('唯一真实标题');
 const result=action({'div,h3,[data-e2e="video-desc"]':[node('不相关标题'),actual,node('唯一真实标题',{getClientRects:()=>[]})]});
 assert.equal(result.found,true);assert.equal(actual.scrolled,true);
 assert.equal(action({'div,h3,[data-e2e="video-desc"]':[actual,node('唯一真实标题')]}).reason,'ambiguous');
 assert.equal(action({'div,h3,[data-e2e="video-desc"]':[node('唯一真实标题的其他作品')]}).reason,'missing');
});
test('matching words inside comments cannot become a work-selection control',()=>{
 assert.equal(action({'div,h3,[data-e2e="video-desc"]':[node('唯一真实标题',{closest:()=>({})})]}).found,false);
});
test('actual official ID links take priority over titles, with duplicate cover/title links sharing the same ID',()=>{
 const actual=node('',{href:`https://www.douyin.com/video/${id}`});
 const result=action({'a[href]':[node('',{href:`https://www.douyin.com.evil.invalid/video/${id}`}),node('',{href:'https://www.douyin.com/video/12345'}),actual,node('',{href:`https://www.douyin.com/video/${id}`})]});
 assert.equal(result.found,true);assert.equal(actual.scrolled,true);
});
test('real modern route, selected active video ID and exact official network error are recognized from public DOM',()=>{
 const input=node('',{value:'AI'}),button=node('搜索'),active=node('',{getAttribute:n=>n==='data-e2e-vid'?id:null});
 const groups={'input[data-e2e="searchbar-input"]':[input],'button[data-e2e="searchbar-button"]':[button],'[data-e2e="feed-active-video"]':[active],'div,p,h1,h2,h3,span,[role="alert"]':[node('网络出现问题')]};
 const location=new URL(`https://www.douyin.com/jingxuan/search/AI?type=general&modal_id=${id}`);
 const result=vm.runInNewContext(`(${douyinVisibleState.toString()})()`,{URL,location,document:{title:'抖音',readyState:'complete',querySelectorAll:s=>groups[s]||[]},getComputedStyle:()=>({visibility:'visible',display:'block'})});
 assert.equal(result.searchReady,true);assert.equal(result.activeId,id);assert.equal(result.modalId,id);assert.equal(result.searchKeyword,'AI');assert.equal(result.blocked,true);assert.match(result.message,/网络/);
});
