import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMaskCandidates } from '../src/auto-tune';
import { mergeSearchResults } from '../src/tuning-state';
test('refinement ambiguity invalidates auto-adoption of retained earlier best without mutating original geometry',async()=>{
  const probabilities=Float32Array.from({length:64*64},(_,i)=>i%64>12&&i%64<51&&Math.floor(i/64)>12&&Math.floor(i/64)<51?.9:.01);
  const first=await searchMaskCandidates({probabilities,width:64,height:64,elapsedMs:0},{width:64,height:64,pixelWidth:640,pixelHeight:640,preset:'test'},{currentEpsilon:1,maxCandidates:4});
  assert.ok(first.best?.safeToAutoApply);
  const second=structuredClone(first);second.candidates=second.candidates.slice(1);
  second.candidates[0].metrics.observedHoleCountMax=1;second.candidates[0].metrics.topologyVariesAcrossThresholds=true;
  const merged=mergeSearchResults(first,second),retained=merged.candidates.find(c=>c.id===first.best!.id)!;
  assert.equal(retained.safeToAutoApply,false);assert.equal(retained.grade,'ambiguous');
  assert.deepEqual(retained.geometry,first.best!.geometry);assert.equal(first.best!.safeToAutoApply,true);
  assert.ok(merged.candidates.every(c=>c.metrics.observedHoleCountMax===1&&!c.safeToAutoApply));
});
