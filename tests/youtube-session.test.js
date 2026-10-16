import test from 'node:test';
import assert from 'node:assert/strict';
import {youtubeOfficialNavigation,youtubeCommentContext} from '../electron/youtube-session.js';

test('YouTube can enter the official Google login and return through YouTube session handoff',()=>{
 for(const value of [
  'https://accounts.google.com/ServiceLogin?service=youtube',
  'https://accounts.google.com/v3/signin/identifier?service=youtube',
  'https://accounts.google.com/signin/v2/challenge/pwd',
  'https://accounts.google.com/AccountChooser?service=youtube',
  'https://accounts.youtube.com/accounts/SetSID',
  'https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2F',
  'https://www.youtube.com/watch?v=vUno6VvDnGk'
 ])assert.equal(youtubeOfficialNavigation(value).allowed,true,value);
});

test('YouTube auth support does not allow arbitrary external hosts, insecure URLs, ports or lookalikes',()=>{
 for(const value of [
  'http://accounts.google.com/ServiceLogin',
  'https://accounts.google.com.evil.invalid/ServiceLogin',
  'https://user:pass@accounts.google.com/ServiceLogin',
  'https://accounts.google.com:7897/ServiceLogin',
  'https://google.com/ServiceLogin',
  'https://mail.google.com/',
  'https://accounts.google.com/unrelated/path',
  'file:///C:/private',
  'javascript:alert(1)'
 ])assert.equal(youtubeOfficialNavigation(value).allowed,false,value);
});

test('YouTube login recognition is separate from viewing and never rewrites the target',()=>{
 assert.deepEqual(youtubeOfficialNavigation('https://accounts.google.com/ServiceLogin'),{allowed:true,authentication:true});
 assert.deepEqual(youtubeOfficialNavigation('https://www.youtube.com/watch?v=test'),{allowed:true,authentication:false});
 assert.deepEqual(youtubeOfficialNavigation('bad URL'),{allowed:false});
});

const selected='https://www.youtube.com/watch?v=vUno6VvDnGk';
test('continuing after official Google authentication restores only the selected work',()=>{
 for(const current of [
  'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.youtube.com%2F',
  'https://accounts.youtube.com/accounts/SetSID',
  'https://consent.youtube.com/m',
  'https://www.youtube.com/',
  'https://youtube.com/?app=desktop',
  'https://m.youtube.com/watch?v=vUno6VvDnGk'
 ])assert.deepEqual(youtubeCommentContext(current,selected),{action:'restore',url:selected},current);
});

test('same selected video keeps its live page and loaded comments',()=>{
 for(const current of [selected+'&lc=public-comment-id',selected+'&list=public-playlist','https://www.youtube.com/shorts/vUno6VvDnGk'])
  assert.deepEqual(youtubeCommentContext(current,selected),{action:'read'},current);
});

test('another video and external or unsafe pages never become a comment source',()=>{
 for(const current of [
  'https://www.youtube.com/watch?v=qAZ5_RAm8-0',
  'https://www.youtube.com/shorts/qAZ5_RAm8-0',
  'https://www.youtube.com/results?search_query=anything',
  'https://accounts.google.com.evil.invalid/v3/signin/identifier',
  'https://other.invalid/',
  'http://www.youtube.com/',
  'https://attacker:password@www.youtube.com/',
  'https://www.youtube.com:7897/'
 ])assert.deepEqual(youtubeCommentContext(current,selected),{action:'blocked'},current);
});

test('a malformed or non-YouTube source cannot be used as a login return target',()=>{
 for(const source of ['https://evil.invalid/watch?v=vUno6VvDnGk','https://www.youtube.com/watch?v=short','javascript:alert(1)','https://www.youtube.com/redirect?q=https://evil.invalid'])
  assert.deepEqual(youtubeCommentContext('https://accounts.google.com/ServiceLogin',source),{action:'blocked'},source);
 assert.deepEqual(youtubeCommentContext('https://www.youtube.com/','https://www.youtube.com/shorts/vUno6VvDnGk'),{action:'restore',url:selected});
});
