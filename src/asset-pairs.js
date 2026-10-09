export function referenceAsset(assets,asset){
  const byId=new Map(assets.map(a=>[a.id,a])),seen=new Set();let current=asset;
  while(current){if(seen.has(current.id))return null;seen.add(current.id);if(current.origin==='original'||current.origin==='imported')return current;current=byId.get(current.originalAssetId);}
  return null;
}
export function assetPairs(draft){
  const assets=draft.assets||[],byId=new Map(assets.map(a=>[a.id,a])),originals=assets.filter(a=>a.origin==='original'),used=new Set();
  const pairs=(draft.assetOrder||[]).map((id,index)=>{const active=byId.get(id);if(!active)return null;const reference=referenceAsset(assets,active);if(reference)used.add(reference.id);return {key:id,active,reference,output:active.origin==='original'?null:active,index,sourceIndex:reference?originals.findIndex(a=>a.id===reference.id):-1};}).filter(Boolean);
  for(const reference of originals){if(!used.has(reference.id))pairs.push({key:'removed-'+reference.id,active:null,reference,output:null,index:-1,sourceIndex:originals.findIndex(a=>a.id===reference.id)});}
  return pairs;
}
