import test from 'node:test';
import assert from 'node:assert/strict';
import {filterComments} from '../src/comment-filter.js';

const comments = [
  {id:'1', userId:'A1', name:'小林', text:'想了解 ＡＩ 报价', region:'佛山', published:'2026-11-01'},
  {id:'2', userId:'A1', name:'小林', text:'已经收到了', region:'广州', published:'2026-11-02'},
  {id:'3', userId:null, name:'匿名', text:'AI 价格多少？', region:'佛山'}
];
const users = [{id:'A1', name:'小林', comments:comments.slice(0,2)}];

test('多个关键词同时命中同一条评论，支持中英文宽度、大小写和跨字段筛选', () => {
  const result=filterComments(comments,users,'  ai　佛山 ');
  assert.deepEqual(result.comments.map(row=>row.id),['1','3']);
  assert.deepEqual(result.users[0].comments.map(row=>row.id),['1']);
  assert.deepEqual(filterComments(comments,users,'报价 广州').users,[]);
});

test('两种视图共享用户 ID 和评论日期匹配条件，空查询恢复所有记录', () => {
  const result=filterComments(comments,users,'ａ１ 11-02');
  assert.deepEqual(result.comments.map(row=>row.id),['2']);
  assert.deepEqual(result.users.map(user=>user.id),['A1']);
  assert.equal(filterComments(comments,users,'  ').comments,comments);
});
