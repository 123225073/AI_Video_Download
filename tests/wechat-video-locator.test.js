import test from 'node:test';
import assert from 'node:assert/strict';
import {wechatFeedId,wechatVideoLocator} from '../electron/wechat-creators.js';

const id='18446744073709551615',nonceId='14887697630331082852',creatorId='exact-fixture@finder';
const encode=value=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(value));return b.toString('base64url');};
const link=(oid=id,nid=nonceId)=>{const u=new URL('https://channels.weixin.qq.com/web/pages/feed');u.searchParams.set('oid',encode(oid));u.searchParams.set('nid',encode(nid));u.searchParams.set('username',creatorId);return u.href;};
const selected=()=>({sourceId:id,creatorId,objectNonceId:nonceId+'_0_146_0_0',acquisition:'wechat-collector',title:'fixture'});

test('uint64 decimal and canonical 8-byte jump IDs retain exact precision including maximum',()=>{
 for(const value of ['0','1','9007199254740993',nonceId,id]){
  assert.equal(wechatFeedId(value),value);assert.equal(wechatFeedId(encode(value)),value);assert.equal(wechatFeedId(encode(value)+'='),value);
 }
 for(const value of [null,undefined,123,9007199254740993n,'','-1','18446744073709551616',' 1','1.0','YWJj','__________9','//////////8='])assert.equal(wechatFeedId(value),null);
});

test('matching creator locator supports encoded and historical decimal links without caching media secrets',()=>{
 const item={...selected(),url:'ignored',decodeKey:'never-copy',mediaURL:'never-copy',unknown:'never-copy'};
 const encoded=wechatVideoLocator(link(),item),decimal=new URL(link());decimal.searchParams.set('oid',id);decimal.searchParams.set('nid',nonceId);
 assert.equal(encoded.sourceId,id);assert.equal(encoded.objectNonceId,item.objectNonceId);assert.equal(encoded.creatorId,creatorId);
 assert.deepEqual(Object.keys(encoded).sort(),['url','platform','acquisition','sourceId','objectNonceId','creatorId','title'].sort());
 assert.equal(wechatVideoLocator(decimal.href,item).sourceId,id);
});

test('selected-work ID, creator identity and numeric nonce mismatches fail before acquisition',()=>{
 for(const patch of [{sourceId:'9007199254740993'},{creatorId:'other@finder'},{objectNonceId:'9007199254740993_0_146'}])assert.throws(()=>wechatVideoLocator(link(),{...selected(),...patch}),/不一致/);
 for(const patch of [{acquisition:'not-collector'},{sourceId:Number(id)},{sourceId:'encoded-id'},{creatorId:'shared_author_fake'},{creatorId:''}])assert.equal(wechatVideoLocator(link(),{...selected(),...patch}),null);
 assert.equal(wechatVideoLocator(link().replace('channels.weixin.qq.com','channels.weixin.qq.com.invalid'),selected()),null);
});

test('invalid nonce fields cannot become a collector locator',()=>{
 for(const objectNonceId of [{},'bad nonce','a'.repeat(201)])assert.throws(()=>wechatVideoLocator(link(),{...selected(),objectNonceId}),/标识/);
 // An unsafe JSON number has already lost bits before String() can preserve it.
 assert.throws(()=>wechatVideoLocator(link(id,String(Number(nonceId))),{...selected(),objectNonceId:Number(nonceId)}),/标识|精度|不一致/);
});
