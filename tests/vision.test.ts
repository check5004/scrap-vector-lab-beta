import {test} from 'node:test';
import assert from 'node:assert/strict';
import {solveHomography,project,customBoard,vectorizeMask,PRESETS} from '../src/vision.ts';
import {validateGeometry} from '../src/geometry.ts';
test('four-point homography maps measured corners and projective interior exactly',()=>{const source=[{x:0,y:0},{x:250,y:0},{x:250,y:170},{x:0,y:170}],target=[{x:100,y:120},{x:1000,y:60},{x:1100,y:800},{x:70,y:850}];const h=solveHomography(source,target),inv=solveHomography(target,source);source.forEach((p,i)=>{const q=project(h,p);assert.ok(Math.hypot(q.x-target[i].x,q.y-target[i].y)<1e-8)});const p={x:71.3,y:88.9},back=project(inv,project(h,p));assert.ok(Math.hypot(p.x-back.x,p.y-back.y)<1e-8);});
test('degenerate homography rejected',()=>assert.throws(()=>solveHomography(Array(4).fill({x:0,y:0}),Array(4).fill({x:1,y:1})),/退化/));
test('custom scale and required presets exact',()=>{assert.equal(PRESETS.a4.pixelWidth,2500);assert.equal(PRESETS.a4.pixelHeight,1700);assert.deepEqual(customBoard(2000,1000),{width:2000,height:1000,pixelWidth:2000,pixelHeight:1000,preset:'CUSTOM'});assert.throws(()=>customBoard(0,500));assert.throws(()=>customBoard(NaN,500));});
test('mask contour pipeline retains actual hole without filling or using photograph edges',()=>{const width=100,height=100,probabilities=new Float32Array(width*height);for(let y=10;y<90;y++)for(let x=10;x<90;x++)if(!(x>35&&x<65&&y>35&&y<65))probabilities[y*width+x]=.99;const result=vectorizeMask({probabilities,width,height,elapsedMs:0},{width:100,height:100,pixelWidth:1000,pixelHeight:1000,preset:'test'},.5);assert.equal(result.geometry.holes.length,1);assert.equal(validateGeometry(result.geometry).valid,true);assert.ok(result.geometry.outer.length>=4);});
test('empty AI mask fails instead of supplying mock coordinates',()=>{assert.throws(()=>vectorizeMask({probabilities:new Float32Array(100),width:10,height:10,elapsedMs:0},PRESETS.a4,1),/見つかりません/);});

test('marker report rejects actual missing and distinct duplicate IDs',async()=>{
 const {assertMarkerReport}=await import('../src/vision.ts');
 const report={markers:[],decodedMarkers:[],rejectedCandidates:[],missingIds:[2,3],duplicateIds:[],candidateCount:0,sourceSize:[600,400],detectorSize:[600,400],elapsedMs:2} as any;
 assert.throws(()=>assertMarkerReport(report),/2, 3.*見つかりません/);
 assert.throws(()=>assertMarkerReport({...report,missingIds:[],duplicateIds:[1]}),/1.*重複/);
 assert.deepEqual(assertMarkerReport({...report,missingIds:[]}),[]);
});
test('debug contour trace exposes real raw rings before mm simplification',async()=>{
 const {traceMask,simplifyMaskTrace}=await import('../src/vision.ts');
 const width=100,height=100,probabilities=new Float32Array(width*height);
 for(let y=10;y<90;y++)for(let x=10;x<90;x++)if(!(x>35&&x<65&&y>35&&y<65))probabilities[y*width+x]=.99;
 probabilities[2*width+2]=.99;
 const trace=traceMask({probabilities,width,height,elapsedMs:1},{width:200,height:100,pixelWidth:2000,pixelHeight:1000,preset:'test'},.5);
 const result=simplifyMaskTrace(trace,.5);
 assert.equal(trace.rawGeometry.holes.length,1);assert.equal(result.geometry.holes.length,1);assert.ok(trace.rawGeometry.outer.length>result.geometry.outer.length);assert.equal(trace.discardedComponentCount,1);assert.equal(trace.contours.length,3);assert.ok(trace.contours.some(c=>c.hole));assert.ok(result.geometry.outer.every(p=>p.x>=20&&p.x<=180));
});
