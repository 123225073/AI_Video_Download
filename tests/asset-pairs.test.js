import test from 'node:test';import assert from 'node:assert/strict';
import {assetPairs,referenceAsset} from '../src/asset-pairs.js';
const original={id:'o',origin:'original'},second={id:'o2',origin:'original'},first={id:'g',origin:'generated',originalAssetId:'o'},later={id:'g2',origin:'generated',originalAssetId:'g'},own={id:'own',origin:'imported'};
test('多次重绘始终配对同一原图，已移除原图不消失，自有图片单独关联',()=>{
 const assets=[original,second,first,later,own],draft={assets,assetOrder:['g2','own']},pairs=assetPairs(draft);
 assert.equal(pairs[0].reference.id,'o');assert.equal(pairs[0].output.id,'g2');assert.equal(pairs[1].reference.id,'own');assert.equal(pairs[2].reference.id,'o2');assert.equal(pairs[2].active,null);
 assert.deepEqual(assets,[original,second,first,later,own]);assert.equal(referenceAsset(assets,later).id,'o');
});
test('未二创的原图右侧是待生成；重排改变二创封面位置，不误换对应原图',()=>{
 const draft={assets:[original,second,first],assetOrder:['o2','g']},pairs=assetPairs(draft);
 assert.equal(pairs[0].output,null);assert.equal(pairs[0].sourceIndex,1);assert.equal(pairs[0].index,0);assert.equal(pairs[1].sourceIndex,0);
});
test('坏记录循环或缺失父节点不会误配另一张原图，也不会无限循环',()=>{
 const a={id:'a',origin:'generated',originalAssetId:'b'},b={id:'b',origin:'generated',originalAssetId:'a'},missing={id:'m',origin:'generated',originalAssetId:'none'};
 assert.equal(referenceAsset([a,b],a),null);assert.equal(referenceAsset([missing,original],missing),null);
 assert.equal(assetPairs({assets:[missing,original],assetOrder:['m']})[0].reference,null);
});
