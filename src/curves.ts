import { APP_BUILD } from './build-info';
import { type Point, type Geometry, type BoardSize, distance, pointToSegmentDistance, validateGeometry, polygonArea, createDxf, bbox } from './geometry';
export interface CurveVertex extends Point { incoming?: Point; outgoing?: Point }
export interface CurveGeometry { outer: CurveVertex[]; holes: CurveVertex[][] }
export const CURVE_TOLERANCE_MM = 0.01;
export const curveRings = (g: CurveGeometry) => [g.outer, ...g.holes];
export const copyCurve = (g: CurveGeometry): CurveGeometry => structuredClone(g);
/** Scale anchors and both controls together around the calibration anchor, exactly once. */
export function transformCurveGeometry(g:CurveGeometry,scaleFactor:number,anchor:Point):CurveGeometry {
  if(!Number.isFinite(scaleFactor)||scaleFactor<=0||!Number.isFinite(anchor.x)||!Number.isFinite(anchor.y))throw Error('Invalid curve calibration.');
  const transform=(p:Point):Point=>({x:anchor.x+(p.x-anchor.x)*scaleFactor,y:anchor.y+(p.y-anchor.y)*scaleFactor});
  const ring=(r:CurveVertex[])=>r.map(p=>({...transform(p),...(p.incoming?{incoming:transform(p.incoming)}:{}),...(p.outgoing?{outgoing:transform(p.outgoing)}:{})}));
  return {outer:ring(g.outer),holes:g.holes.map(ring)};
}
const mix = (a: Point, b: Point): Point => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
export function curvePath(ring: CurveVertex[]): string {
  return `M ${ring[0].x} ${ring[0].y} `+ring.map((a,i)=>{
    const b=ring[(i+1)%ring.length], c=a.outgoing??a,d=b.incoming??b;
    return a.outgoing||b.incoming?`C ${c.x} ${c.y} ${d.x} ${d.y} ${b.x} ${b.y}`:`L ${b.x} ${b.y}`;
  }).join(' ')+' Z';
}
/** de Casteljau subdivision. Convex hull bounds deviation; control polygon bounds length. */
export function flattenEdge(a: CurveVertex,b: CurveVertex,tolerance=CURVE_TOLERANCE_MM): {points:Point[];lower:number;upper:number} {
  if(!Number.isFinite(tolerance)||tolerance<=0)throw Error('Tolerance must be positive.');
  const points:Point[]=[{x:a.x,y:a.y}];let lower=0,upper=0;
  function visit(p:Point,q:Point,r:Point,s:Point,budget:number,depth:number){
    if([p,q,r,s].some(v=>!Number.isFinite(v.x)||!Number.isFinite(v.y)))throw Error('Non-finite curve.');
    const chord=distance(p,s),polygon=distance(p,q)+distance(q,r)+distance(r,s);
    if(Math.max(pointToSegmentDistance(q,p,s),pointToSegmentDistance(r,p,s))<=tolerance && polygon-chord<=budget){points.push({x:s.x,y:s.y});lower+=chord;upper+=polygon;return;}
    if(depth>=22||points.length>16384)throw Error('Curve is too complex; shorten handles.');
    const pq=mix(p,q),qr=mix(q,r),rs=mix(r,s),u=mix(pq,qr),v=mix(qr,rs),m=mix(u,v);
    visit(p,pq,u,m,budget/2,depth+1);visit(m,v,rs,s,budget/2,depth+1);
  }
  visit(a,a.outgoing??a,b.incoming??b,b,tolerance,0);return {points,lower,upper};
}
export function flattenCurve(g:CurveGeometry,tolerance=CURVE_TOLERANCE_MM):Geometry {
  let count=0;
  const rings=curveRings(g).map(r=>r.flatMap((a,i)=>{const points=flattenEdge(a,r[(i+1)%r.length],tolerance).points.slice(0,-1);count+=points.length;if(count>2048)throw Error('Curve exceeds the 2048-segment validation budget; simplify or shorten handles.');return points;}));
  return {outer:rings[0],holes:rings.slice(1)};
}
export function validateCurve(g:CurveGeometry){
  try {if(curveRings(g).some(r=>r.length<3))throw Error('Each ring needs three anchors.');return validateGeometry(flattenCurve(g));}
  catch(e){return {valid:false,errors:[String(e)]};}
}
export function curveMetrics(g:CurveGeometry){
  const flat=flattenCurve(g); const validation=validateGeometry(flat);if(!validation.valid)throw Error(validation.errors.join(' '));
  const edges=curveRings(g).map(r=>r.map((a,i)=>{const f=flattenEdge(a,r[(i+1)%r.length]);return {length_mm:(f.lower+f.upper)/2,length_error_bound_mm:(f.upper-f.lower)/2};}));
  return {area_approx_mm2:polygonArea(flat.outer)-flat.holes.reduce((s,r)=>s+polygonArea(r),0),outer_length_mm:edges[0].reduce((s,e)=>s+e.length_mm,0),edges,flatten_tolerance_mm:CURVE_TOLERANCE_MM};
}
/** Only adjacent nearly collinear anchors; never silently erase a corner, handle, hole or cross-ring gap. */
export function mergeNearby(g:CurveGeometry,tolerance:number):{geometry:CurveGeometry;removed:number}{
  if(!Number.isFinite(tolerance)||tolerance<0||tolerance>10)throw Error('Merge tolerance must be 0–10 mm.');
  const out=copyCurve(g);let removed=0;
  for(const ring of curveRings(out)){
    let changed=true;
    while(changed&&ring.length>3){changed=false;
      for(let i=0;i<ring.length;i++){
        const previous=ring[(i+ring.length-1)%ring.length],p=ring[i],next=ring[(i+1)%ring.length];
        if(p.incoming||p.outgoing||previous.outgoing||next.incoming)continue;
        const short=Math.min(distance(previous,p),distance(p,next));if(short>tolerance)continue;
        const ux=p.x-previous.x,uy=p.y-previous.y,vx=next.x-p.x,vy=next.y-p.y;
        const turn=Math.atan2(Math.abs(ux*vy-uy*vx),ux*vx+uy*vy)*180/Math.PI;
        if(short>1e-9 && turn>5)continue;
        ring.splice(i,1);removed++;changed=true;break;
      }
    }
  }
  return validateCurve(out).valid?{geometry:out,removed}:{geometry:copyCurve(g),removed:0};
}
export function curveJson(g:CurveGeometry,board:BoardSize,provenance:Record<string,unknown>={}){
  return JSON.stringify({schema_version:'2.0-beta',units:'mm',coordinate_system:'image_x_right_y_down',board_size_mm:board,geometry:g,measurement:curveMetrics(g),provenance:{...provenance,app_build:APP_BUILD},warning:'Estimated Bezier geometry (automatic or manually adjusted). Area and topology use flattened curves; not certified manufacturing geometry.'},null,2);
}
export function curveSvg(g:CurveGeometry,board:BoardSize,provenance:Record<string,unknown>={}){
  curveMetrics(g);const controls=curveRings(g).flatMap(r=>r.flatMap(p=>[p,...(p.incoming?[p.incoming]:[]),...(p.outgoing?[p.outgoing]:[])]));
  const b=bbox(controls),x=Math.min(0,b.minX),y=Math.min(0,b.minY),w=Math.max(board.width,b.maxX)-x,h=Math.max(board.height,b.maxY)-y;
  const metadata=curveJson(g,board,provenance).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${x} ${y} ${w} ${h}"><metadata>${metadata}</metadata><desc>Estimated cubic Bezier geometry; millimetres; not certified manufacturing geometry.</desc><path d="${curveRings(g).map(curvePath).join(' ')}" fill="#c2b593" fill-rule="evenodd" stroke="#26382f" stroke-width="0.35"/></svg>`;
}
export function curveDxf(g:CurveGeometry,board:BoardSize){
  curveMetrics(g);return `999\nBezier approximation; maximum chord deviation ${CURVE_TOLERANCE_MM} mm; estimated geometry\n`+createDxf(flattenCurve(g),board);
}
/** Local three-anchor quadratic fit represented losslessly as a cubic. No global smoothing. */
export function fitLocalCurve(g:CurveGeometry,ringIndex:number,index:number,tolerance:number){
  if(!Number.isFinite(tolerance)||tolerance<0.02||tolerance>10)throw Error('Fit tolerance must be 0.02–10 mm.');
  const result=copyCurve(g),r=curveRings(result)[ringIndex];
  if(r.length<=3)throw Error('Three anchors must remain.');
  const a=r[(index+r.length-1)%r.length],p=r[index],b=r[(index+1)%r.length];
  if(a.outgoing||p.incoming||p.outgoing||b.incoming)throw Error('Select two straight segments.');
  const ux=p.x-a.x,uy=p.y-a.y,vx=b.x-p.x,vy=b.y-p.y;
  if(Math.atan2(Math.abs(ux*vy-uy*vx),ux*vx+uy*vy)>Math.PI/4)throw Error('Corner exceeds 45 degrees; use manual handles to preserve intent.');
  const q={x:2*p.x-(a.x+b.x)/2,y:2*p.y-(a.y+b.y)/2};
  a.outgoing={x:a.x+2*(q.x-a.x)/3,y:a.y+2*(q.y-a.y)/3};b.incoming={x:b.x+2*(q.x-b.x)/3,y:b.y+2*(q.y-b.y)/3};
  const f=flattenEdge(a,b,0.002),segments=f.points.slice(1).map((v,i)=>[f.points[i],v]);
  // Directed distance is 1-Lipschitz; half the sample spacing bounds unsampled error.
  const spacing=Math.min(0.1,tolerance/8),margin=spacing/2+0.002;
  let error=0,operations=0;
  const check=()=>{if(++operations>100000)throw Error('区間が大きすぎます。短い区間を選ぶか、手動ハンドルで調整してください。');if(error>tolerance)throw Error(`元の2辺からの誤差が許容差 ${tolerance} mm を超えます。`);};
  for(const [start,end] of [[a,p],[p,b]]){const n=Math.ceil(distance(start,end)/spacing);for(let j=0;j<=n;j++){check();const t=n?j/n:0,v={x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t};error=Math.max(error,Math.min(...segments.map(([c,d])=>{check();return pointToSegmentDistance(v,c,d);}))+margin);}}
  for(const [start,end] of segments){const n=Math.ceil(distance(start,end)/spacing);for(let j=0;j<=n;j++){check();const t=n?j/n:0,v={x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t};error=Math.max(error,Math.min(pointToSegmentDistance(v,a,p),pointToSegmentDistance(v,p,b))+margin);}}
  if(error>tolerance)throw Error(`元の2辺からの誤差上限 ${error.toFixed(3)} mm が許容差を超えます。`);
  r.splice(index,1);if(!validateCurve(result).valid)throw Error('Curve candidate changes valid topology.');
  return {geometry:result,errorBoundMm:error};
}

/** Straight-first simplification bounded against the supplied cubic control hull, not a photograph. */
export function linearizeNearlyStraightCurves(source:CurveGeometry,toleranceMm:number){
  if(!Number.isFinite(toleranceMm)||toleranceMm<0||toleranceMm>10)throw Error('Line tolerance must be 0–10 mm.');
  const geometry=copyCurve(source);let linearizedEdges=0;
  for(const ring of curveRings(geometry))for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];if(!a.outgoing&&!b.incoming)continue;
    if(Math.max(pointToSegmentDistance(a.outgoing??a,a,b),pointToSegmentDistance(b.incoming??b,a,b))>toleranceMm)continue;
    delete a.outgoing;delete b.incoming;linearizedEdges++;
  }
  return validateCurve(geometry).valid?{geometry,linearizedEdges}:{geometry:copyCurve(source),linearizedEdges:0};
}
