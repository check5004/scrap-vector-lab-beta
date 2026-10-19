import { type Geometry, type BoardSize, bbox } from './geometry';
import {fitLocalCurve,copyCurve,curveRings,curvePath,curveMetrics,validateCurve,mergeNearby,curveJson,curveSvg,curveDxf,type CurveGeometry,type CurveVertex} from './curves';
import './curve-editor.css';
let draft:{identity:Geometry;signature:string;geometry:CurveGeometry;history:CurveGeometry[];selected:{ring:number;index:number}}|undefined;
export function openCurveEditor(source:Geometry,board:BoardSize,provenance:Record<string,unknown>={},background?:{url:string;scale:number;anchor:{x:number;y:number}},identity:Geometry=source){
  const signature=JSON.stringify([source,provenance.measurement_calibration??null]),cached=draft?.identity===identity&&draft.signature===signature?draft:undefined;
  let geometry:CurveGeometry=copyCurve(cached?.geometry??source),history:CurveGeometry[]=structuredClone(cached?.history??[]),selected={...(cached?.selected??{ring:0,index:0})};
  if(!cached)draft=undefined;
  let proposal:{before:CurveGeometry;error:number}|undefined;
  let drag:{ring:number;index:number;kind:string;pointerId:number;offset:{x:number;y:number};before:CurveGeometry;start:{x:number;y:number}}|undefined;
  const dialog=document.createElement('dialog');dialog.className='curve-editor';dialog.setAttribute('aria-label','ベジェ曲線編集 beta');
  dialog.innerHTML=`<header><h2>曲線・頂点編集 <small>BETA</small></h2><button data-action="close">閉じる</button></header><p>頂点を選び「次の辺を曲線に」。青い点を動かして調整します。元の解析結果は保持します。</p><div class="curve-tools"><label>頂点 <select data-anchor aria-label="編集する頂点"></select></label><button data-action="curve">次の辺を曲線に</button><button data-action="line">次の辺を直線に</button><button data-action="undo">↶ 戻す</button></div><details class="curve-advanced"><summary>頂点の整理・曲線候補（詳細）</summary><div class="curve-tools"><button data-action="reset">元の輪郭に戻す</button><label>統合距離 mm <input data-merge type="number" min="0" max="10" step="0.1" value="0.5"></label><button data-action="merge">近接点を統合</button><label>曲線許容差 mm <input data-fit type="number" min="0.02" max="10" step="0.1" value="1"></label><button data-action="fit">選択点の前後を曲線候補に</button><button data-action="accept" hidden>候補を採用</button><button data-action="reject" hidden>候補を取消</button></div><p class="hint">統合は隣接・ほぼ一直線の点だけです。角・穴・曲線ハンドルは保持。εによる輪郭の直線化とは別の調整です。</p><p class="hint">SVGはベジェを保持。DXFは最大弦偏差0.01 mmの折線近似。面積・交差検査も0.01 mm近似で、微小な交差の不存在は保証しません。加工前にCADと実測で確認してください。編集は同じ解析結果の間、このページ内に保持します。閉じても続きから再開できます。画像・解析結果・校正の変更やページ再読込で失われるため、必要な結果を書き出してください。</p></details><svg class="curve-canvas" role="img" aria-label="曲線編集キャンバス"></svg><p data-selection></p><div class="curve-coordinates"><label>点 X mm <input data-x type="number" step="0.1"></label><label>点 Y mm <input data-y type="number" step="0.1"></label><button data-action="coordinate">選択頂点へ適用</button></div><p data-metrics></p><p data-status role="status" aria-live="polite"></p><footer><button data-action="svg">曲線 SVG</button><button data-action="dxf">近似 DXF</button><button data-action="json">曲線 JSON</button></footer><p class="hint">手動編集した推定輪郭です。加工前に実測・CADで確認してください。</p>`;
  document.body.append(dialog);dialog.showModal();
  const svg=dialog.querySelector<SVGSVGElement>('svg')!,status=dialog.querySelector<HTMLElement>('[data-status]')!;
  const bounds=bbox(source),pad=Math.max(bounds.width,bounds.height)*.15+5;
  svg.setAttribute('viewBox',`${bounds.minX-pad} ${bounds.minY-pad} ${bounds.width+pad*2} ${bounds.height+pad*2}`);
  const scale=Math.max((bounds.width+pad*2)/Math.max(250,svg.clientWidth),(bounds.height+pad*2)/Math.max(260,svg.clientHeight)),hit=20*scale,visual=5*scale;
  dialog.querySelector<HTMLSelectElement>('[data-anchor]')!.onchange=e=>{const [ring,index]=(e.target as HTMLSelectElement).value.split(',').map(Number);selected={ring,index};render();};
  function point(){return curveRings(geometry)[selected.ring][selected.index];}
  function render(){
    const picker=dialog.querySelector<HTMLSelectElement>('[data-anchor]')!;
    picker.innerHTML=curveRings(geometry).flatMap((r,ri)=>r.map((_,i)=>`<option value="${ri},${i}">${ri?'穴 '+ri:'外周'} · ${i+1}</option>`)).join('');picker.value=`${selected.ring},${selected.index}`;picker.disabled=!!drag||!!proposal;
    for(const action of ['accept','reject'])dialog.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.hidden=!proposal;
    for(const action of ['curve','line','coordinate','merge','fit','reset'])dialog.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.disabled=!!proposal;
    let html=(background?`<image href="${background.url}" x="${background.anchor.x*(1-background.scale)}" y="${background.anchor.y*(1-background.scale)}" width="${board.width*background.scale}" height="${board.height*background.scale}" opacity="0.7"/>`:'')+`<path d="${curveRings(source).map(curvePath).join(' ')}" fill="none" stroke="#999" stroke-width="${scale}" stroke-dasharray="${3*scale} ${3*scale}"/><path d="${curveRings(geometry).map(curvePath).join(' ')}" fill="#c2b59355" fill-rule="evenodd" stroke="#234f35" stroke-width="${2*scale}"/>`;
    curveRings(geometry).forEach((ring,ri)=>ring.forEach((p,i)=>{
      const chosen=ri===selected.ring&&i===selected.index;
      html+=`<circle data-kind="anchor" data-ring="${ri}" data-index="${i}" cx="${p.x}" cy="${p.y}" r="${hit}" fill="transparent"/><circle cx="${p.x}" cy="${p.y}" r="${visual}" fill="${chosen?'#e19152':'white'}" stroke="#234f35" stroke-width="${scale}" pointer-events="none"/>`;
    }));
    const r=curveRings(geometry)[selected.ring],indices=new Set([selected.index,(selected.index+1)%r.length]);
    for(const i of indices){const p=r[i];for(const kind of ['incoming','outgoing'] as const){const h=p[kind];if(!h)continue;html+=`<line x1="${p.x}" y1="${p.y}" x2="${h.x}" y2="${h.y}" stroke="#137ac0" stroke-width="${scale}" pointer-events="none"/><circle data-kind="${kind}" data-ring="${selected.ring}" data-index="${i}" cx="${h.x}" cy="${h.y}" r="${hit}" fill="transparent"/><circle cx="${h.x}" cy="${h.y}" r="${visual}" fill="#137ac0" pointer-events="none"/>`;}}
    svg.innerHTML=html;
    dialog.querySelector('[data-selection]')!.textContent=`${selected.ring?'穴 '+selected.ring:'外周'} / 頂点 ${selected.index+1} · ハンドルはそれぞれ独立して操作できます。`;
    for(const axis of ['x','y'] as const)dialog.querySelector<HTMLInputElement>(`[data-${axis}]`)!.value=String(point()[axis]);
    try{const m=curveMetrics(geometry);dialog.querySelector('[data-metrics]')!.textContent=`外周曲線長 ≈ ${m.outer_length_mm.toFixed(2)} mm / 面積 ≈ ${m.area_approx_mm2.toFixed(2)} mm²`;}catch{dialog.querySelector('[data-metrics]')!.textContent='交差・穴・曲線を確認してください。';}
    dialog.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled=!!proposal||!history.length;
    for(const action of ['svg','dxf','json'])dialog.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.disabled=!!proposal||!!drag||!validateCurve(geometry).valid;
  }
  function commit(before:CurveGeometry){const valid=validateCurve(geometry);if(!valid.valid){geometry=before;status.textContent='交差・接触・穴のはみ出し、または複雑すぎる曲線のため取り消しました。';}else{history.push(before);if(history.length>50)history.shift();status.textContent='編集を反映しました。寸法は手動編集した輪郭の推定値です。';}render();}
  function moveAnchor(p:CurveVertex,x:number,y:number){const dx=x-p.x,dy=y-p.y;p.x=x;p.y=y;for(const kind of ['incoming','outgoing'] as const)if(p[kind]){p[kind]!.x+=dx;p[kind]!.y+=dy;}}
  svg.onpointerdown=e=>{const target=(e.target as Element).closest<SVGElement>('[data-kind]');if(!target||drag||proposal)return;e.preventDefault();const ring=Number(target.dataset.ring),index=Number(target.dataset.index),kind=target.dataset.kind!;if(kind==='anchor')selected={ring,index};const matrix=svg.getScreenCTM();if(!matrix)return;const cursor=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()),vertex=curveRings(geometry)[ring][index],targetPoint=kind==='anchor'?vertex:vertex[kind as 'incoming'|'outgoing']!;drag={ring,index,kind,pointerId:e.pointerId,offset:{x:targetPoint.x-cursor.x,y:targetPoint.y-cursor.y},before:copyCurve(geometry),start:{x:e.clientX,y:e.clientY}};svg.setPointerCapture(e.pointerId);render();};
  svg.onpointermove=e=>{if(!drag||e.pointerId!==drag.pointerId)return;const matrix=svg.getScreenCTM();if(!matrix)return;const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());p.x+=drag.offset.x;p.y+=drag.offset.y;const vertex=curveRings(geometry)[drag.ring][drag.index];if(drag.kind==='anchor')moveAnchor(vertex,p.x,p.y);else vertex[drag.kind as 'incoming'|'outgoing']={x:p.x,y:p.y};render();};
  svg.onpointerup=e=>{if(!drag||e.pointerId!==drag.pointerId)return;const before=drag.before;const moved=Math.hypot(e.clientX-drag.start.x,e.clientY-drag.start.y)>2;drag=undefined;if(moved)commit(before);else{geometry=before;render();}};
  svg.onpointercancel=e=>{if(drag&&e.pointerId===drag.pointerId){geometry=drag.before;drag=undefined;render();}};
  svg.onlostpointercapture=e=>{if(drag&&e.pointerId===drag.pointerId){geometry=drag.before;drag=undefined;render();}};
  function close(){const retained=proposal?.before??drag?.before??geometry;draft={identity,signature,geometry:copyCurve(retained),history:structuredClone(history),selected:{...selected}};if(proposal)draft.selected={ring:0,index:0};dialog.close();dialog.remove();}
  dialog.oncancel=e=>{e.preventDefault();close();};
  dialog.onclick=e=>{const action=(e.target as Element).closest<HTMLElement>('[data-action]')?.dataset.action;if(!action||drag)return;const before=copyCurve(geometry),r=curveRings(geometry)[selected.ring],p=point(),next=r[(selected.index+1)%r.length];
    try{
      if(action==='close'){close();return;}
      if(action==='accept'&&proposal){const original=proposal.before;proposal=undefined;commit(original);return;}
      if(action==='reject'&&proposal){geometry=proposal.before;proposal=undefined;selected={ring:0,index:0};status.textContent='候補を取り消しました。';render();return;}
      if(proposal)return;
      if(action==='fit'){const fitted=fitLocalCurve(geometry,selected.ring,selected.index,Number(dialog.querySelector<HTMLInputElement>('[data-fit]')!.value));proposal={before,error:fitted.errorBoundMm};geometry=fitted.geometry;selected.index=Math.max(0,selected.index-1);render();status.textContent=`候補プレビュー: 選択点前後の2辺に対する双方向誤差上限 ${fitted.errorBoundMm.toFixed(3)} mm。元の写真への精度ではありません。採用または取消してください。`;return;}
      if(action==='reset'){if(!window.confirm('曲線と頂点の編集を元の解析輪郭に戻しますか？「戻す」で取り消せます。'))return;geometry=copyCurve(source);selected={ring:0,index:0};commit(before);return;}
      if(action==='undo'){geometry=history.pop()??geometry;selected={ring:0,index:0};status.textContent='一つ前に戻しました。';render();return;}
      if(action==='curve'){p.outgoing={x:p.x+(next.x-p.x)/3,y:p.y+(next.y-p.y)/3};next.incoming={x:p.x+2*(next.x-p.x)/3,y:p.y+2*(next.y-p.y)/3};commit(before);status.textContent='形を変えずにハンドルを作りました。青い点を動かして曲がりを調整してください。';return;}
      if(action==='line'){delete p.outgoing;delete next.incoming;commit(before);return;}
      if(action==='coordinate'){if(['x','y'].some(axis=>!dialog.querySelector<HTMLInputElement>(`[data-${axis}]`)!.value.trim()))throw Error('XとYの両方を入力してください。');const x=Number(dialog.querySelector<HTMLInputElement>('[data-x]')!.value),y=Number(dialog.querySelector<HTMLInputElement>('[data-y]')!.value);if(!Number.isFinite(x)||!Number.isFinite(y))throw Error('有限の座標を入力してください。');moveAnchor(p,x,y);commit(before);return;}
      if(action==='merge'){const result=mergeNearby(geometry,Number(dialog.querySelector<HTMLInputElement>('[data-merge]')!.value));geometry=result.geometry;selected={ring:0,index:0};if(result.removed)commit(before);else render();status.textContent=`${result.removed}点を統合しました。角やハンドル付きの点は残します。`;return;}
      const exports={svg:()=>curveSvg(geometry,board,provenance),dxf:()=>curveDxf(geometry,board),json:()=>curveJson(geometry,board,provenance)};
      if(action in exports){const content=exports[action as keyof typeof exports](),url=URL.createObjectURL(new Blob([content],{type:action==='svg'?'image/svg+xml':action==='json'?'application/json':'application/dxf'})),a=document.createElement('a');a.href=url;a.download=`scrap-curves-beta.${action}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent=`${action.toUpperCase()}のダウンロードを開始しました。`;}
    }catch(error){geometry=before;status.textContent=String(error);render();}
  };render();
}
