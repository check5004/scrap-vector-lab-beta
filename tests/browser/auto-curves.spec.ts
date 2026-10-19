import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { sourceReady, openDetailsFor, openEditor } from './legacy-ui';
import { mockProvider, syntheticKeys, testShape } from './provider-fixture';

type Point={x:number;y:number};
type Vertex=Point&{incoming?:Point;outgoing?:Point};
type CurveExport={schema_version:string;geometry:{outer:Vertex[];holes:Vertex[][]};measurement:{area_approx_mm2:number;outer_length_mm:number};provenance:Record<string,any>};
let unexpected:string[],errors:string[];
test.beforeEach(async({page,context,baseURL})=>{
  unexpected=[];errors=[];
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin===new URL(baseURL!).origin)return route.continue();
    unexpected.push(route.request().url());return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*',socket=>socket.close());
  page.on('pageerror',e=>errors.push(e.message));
});
test.afterEach(()=>{expect(unexpected,'No paid/live provider or other external traffic').toEqual([]);expect(errors).toEqual([]);});
async function openSource(page:Page){await page.goto('/');await sourceReady(page,undefined,{keepAutomaticCurves:true});await expect(page.locator('#automaticCurves')).toBeChecked();}
async function complete(page:Page){await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state','complete',{timeout:200000});await expect(page.locator('#analyze')).toBeEnabled();await expect(page.locator('#exportJson')).toBeEnabled();}
async function textDownload(page:Page,id='#exportJson'){
  const pending=page.waitForEvent('download');await page.locator(id).click();const file=await pending,path=await file.path();if(!path)throw Error('Missing actual download');return readFile(path,'utf8');
}
async function jsonDownload(page:Page):Promise<CurveExport>{return JSON.parse(await textDownload(page));}
function ringVertices(g:CurveExport['geometry']){return[g.outer,...g.holes].flat();}

// This fixture exercises the genuine supplied image, marker detection, local
// ONNX/WASM model, dense mask trace, tuning search and automatic fitting.
test('default one-click B fits dense evidence and owns page03 overlay, metrics and exports',async({page},info)=>{
  test.setTimeout(260000);await openSource(page);
  await expect(page.locator('#automaticCurveStatus')).toContainText('解析すると');
  await page.locator('#analyze').click();await complete(page);
  await expect(page.locator('#automaticCurveResult')).toHaveAttribute('data-state','fitted');
  await expect(page.locator('#resultCurvePreview')).toBeVisible();await expect(page.locator('#resultCurvePreview')).toHaveAttribute('data-result','curve');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after=await jsonDownload(page),meta=after.provenance.automatic_curve;
  expect(after.schema_version).toBe('2.0-beta');expect(after.provenance.method).toBe('U2NetP-ONNX-WASM');
  expect(meta.source).toBe('traceMask.rawGeometry_before_simplification');expect(meta.straightPriority).toBe(true);
  expect(meta.rawPointCount).toBe(after.provenance.original_dense_geometry_mm.outer.length+after.provenance.original_dense_geometry_mm.holes.flat().length);
  expect(meta.rawPointCount).toBeGreaterThan(after.provenance.original_straight_geometry_mm.outer.length);
  expect(meta.maxErrorBoundMm).toBeLessThanOrEqual(meta.toleranceMm);expect(meta.operations).toBeLessThanOrEqual(4000000);
  expect(Number((await page.locator('#area').innerText()).replaceAll(',',''))).toBe(Math.round(after.measurement.area_approx_mm2));
  await page.locator('#showDenseContour').check();await expect(page.locator('#resultCurvePreview [data-dense-outline]')).toHaveCount(1);
  const svg=await textDownload(page,'#exportSvg');expect(svg).toContain('<path');expect(svg).toContain('2.0-beta');if(meta.cubicCount)expect(svg).toMatch(/C [\d.-]+/);
  const dxf=await textDownload(page,'#exportDxf');expect(dxf).toContain('0.01');expect(dxf).toContain('LWPOLYLINE');
  await page.locator('#showOriginalCurve').click();await expect(page.locator('#resultCurvePreview')).toHaveAttribute('data-result','polygon');
  const before:any=await jsonDownload(page);expect(before.outer_vertices_mm.map(({x,y}:Point)=>({x,y}))).toEqual(after.provenance.original_straight_geometry_mm.outer);
  await page.locator('#showAutomaticCurve').click();expect((await jsonDownload(page)).geometry).toEqual(after.geometry);
  await page.locator('#refineCurves').click();const modal=page.getByRole('dialog');await expect(modal).toBeVisible();
  const seed=await modal.locator('svg path').last().getAttribute('d');expect(seed).toBe(await page.locator('#resultCurvePreview [data-result-outline]').getAttribute('d'));
  await modal.locator('[data-action="close"]').click();
  await page.screenshot({path:info.outputPath('automatic-real-B-result.png'),fullPage:true});
  await page.locator('#automaticCurveResult').screenshot({path:info.outputPath('automatic-real-B-result-detail.png')});
  // Cancellation preserves the straight result; a genuinely changed setting
  // invalidates the candidate/draft and refits the current dense mask.
  await page.locator('#cancelAutomaticCurve').click();await expect(page.locator('#showAutomaticCurve')).toBeDisabled();
  expect((await jsonDownload(page) as any).outer_vertices_mm).toEqual(before.outer_vertices_mm);
  await openDetailsFor(page,'#curveTolerance');await page.locator('#curveTolerance').fill('1.1');await page.locator('#minimumCurveLength').focus();
  await expect(page.locator('#resultCurvePreview')).toBeVisible();await expect(page.locator('#resultCurvePreview')).toHaveAttribute('data-result','curve');
  const refit=await jsonDownload(page);expect(refit.provenance.automatic_curve.source_revision).toBeGreaterThan(meta.source_revision);expect(refit.provenance.automatic_curve.toleranceMm).toBe(1.1);
  // Invalid settings fail closed without replacing the safe polygon.
  await page.locator('#curveTolerance').fill('0');await page.locator('#minimumCurveLength').focus();
  await expect(page.locator('#automaticCurveResult')).toHaveAttribute('data-state','invalid');await expect(page.locator('#resultCurvePreview')).toHaveAttribute('data-result','polygon');await expect(page.locator('#automaticCurveStatus')).toContainText('保持');
  expect((await jsonDownload(page) as any).outer_vertices_mm).toEqual(before.outer_vertices_mm);
  await page.locator('#curveTolerance').fill('99');await page.locator('#minimumCurveLength').focus();await expect(page.locator('#automaticCurveResult')).toHaveAttribute('data-state','invalid');await expect(page.locator('#automaticCurveStatus')).toContainText('0.1〜10');
  await page.locator('#curveTolerance').fill('1');await page.locator('#minimumCurveLength').focus();
  await openEditor(page);await page.locator('#editC').click();await expect(page.locator('#resultCurvePreview')).toHaveAttribute('data-result-mode','C');await expect(page.locator('#showAutomaticCurve')).toBeDisabled();
  const manual:any=await jsonDownload(page);expect(manual.schema_version).not.toBe('2.0-beta');expect(manual.provenance.automatic_curve).toBeUndefined();
  await openDetailsFor(page,'[data-sample="notched"]');await page.locator('[data-sample="notched"]').click();await sourceReady(page,undefined,{keepAutomaticCurves:true});
  await expect(page.locator('#resultCurvePreview')).toBeHidden();await expect(page.locator('#exportJson')).toBeDisabled();await expect(page.locator('#showAutomaticCurve')).toBeDisabled();
});

const curvedShape={...testShape,shape_type:'TEST_ONLY_native_mixed_curve',outer_vertices_mm:[
  {x:40,y:40,incoming:null,outgoing:null},
  {x:160,y:40,incoming:null,outgoing:{x:210,y:40}},
  {x:160,y:130,incoming:{x:210,y:130},outgoing:null},
  {x:40,y:130,incoming:null,outgoing:null},
],holes_vertices_mm:[]};

test('test-only native A curve is automatic, calibrated once, optionally fine-tuned and restorable',async({page},info)=>{
  const api=await mockProvider(page,'openrouter','shape',()=>({shape:curvedShape as any}));
  await openSource(page);await page.locator('#methodA').check();await page.locator('#configureKey').click();await page.locator('#apiKey').fill(syntheticKeys.openrouter);await page.locator('#analyze').click();await complete(page);
  expect(api.inferenceCalls()).toBe(1);await expect(page.locator('[data-journey-step="mask"]')).toHaveCount(0);
  await expect(page.locator('#curveResultDetail')).toContainText('実API未検証');await expect(page.locator('#curveResultDetail')).toContainText('独立した検出結果ではありません');await expect(page.locator('#showDenseContour')).toBeDisabled();
  const initial=await jsonDownload(page);
  await page.locator('#journeySkip').click();
  expect(JSON.parse((await page.locator('#journeyOverlay [data-curve-geometry-mm]').getAttribute('data-curve-geometry-mm'))!)).toEqual(initial.geometry);
  await expect(page.locator('#journeyOverlay [data-edge-kind="curve"]').first()).toBeAttached();expect(initial.geometry.outer[1].outgoing).toEqual({x:210,y:40});expect(initial.provenance.automatic_curve.dense_contour_error_bound).toBe(false);
  await expect(page.locator('#edges')).toContainText('直線');await expect(page.locator('#edges')).toContainText('曲線長');
  const outline=await page.locator('#resultCurvePreview [data-result-outline]').getAttribute('d');
  await openDetailsFor(page,'#applyCalibration');const original=initial.provenance.original_straight_geometry_mm.outer,a=original[0],b=original[1],length=Math.hypot(a.x-b.x,a.y-b.y);
  await page.locator('#calibrationEdge').selectOption('0');await page.locator('#calibrationLength').fill(String(length*1.5));await page.locator('#calibrationAssumptions').check();await page.locator('#applyCalibration').click();
  const scaled=await jsonDownload(page);for(const [i,p] of ringVertices(initial.geometry).entries())for(const key of ['anchor','incoming','outgoing'] as const){const before=key==='anchor'?p:p[key],after=key==='anchor'?ringVertices(scaled.geometry)[i]:ringVertices(scaled.geometry)[i][key];if(!before){expect(after).toBeUndefined();continue;}expect(after!.x).toBeCloseTo(a.x+(before.x-a.x)*1.5,8);expect(after!.y).toBeCloseTo(a.y+(before.y-a.y)*1.5,8);}
  await expect(page.locator('#resultCurvePreview [data-result-outline]')).toHaveAttribute('d',outline!);await expect(page.locator('#resultCurvePreview image')).toHaveAttribute('width','250');
  expect(scaled.measurement.outer_length_mm/initial.measurement.outer_length_mm).toBeCloseTo(1.5,3);
  await page.locator('#refineCurves').click();const modal=page.getByRole('dialog');await expect(modal.locator('svg image')).toHaveAttribute('width','375');
  await expect(modal.locator('[data-kind="outgoing"]')).toHaveCount(1);await modal.locator('[data-x]').fill(String(a.x+1));await modal.locator('[data-action="coordinate"]').click();await modal.locator('[data-action="apply"]').click();
  await expect(modal).toHaveCount(0);const refined=await jsonDownload(page);expect(refined.provenance.automatic_curve.manual_refinement).toBe(true);expect(refined.provenance.automatic_curve.error_bound_applies_to_current_geometry).toBe(false);expect(refined.geometry.outer[0].x).toBeCloseTo(a.x+1,8);
  // A new run cannot reuse old manual controls; explicit restore can recover
  // the saved result with its own original coordinates and calibration.
  await page.locator('#analyze').click();await complete(page);expect(api.inferenceCalls()).toBe(2);expect((await jsonDownload(page)).provenance.automatic_curve.manual_refinement).toBe(false);
  await page.locator('#restoreAnalysis').click();const restored=await jsonDownload(page);expect(restored.geometry).toEqual(refined.geometry);expect(restored.provenance.automatic_curve.manual_refinement).toBe(true);
  await page.screenshot({path:info.outputPath('automatic-A-TEST-ONLY-calibrated-refined.png'),fullPage:true});
  await page.locator('#automaticCurveResult').screenshot({path:info.outputPath('automatic-A-TEST-ONLY-calibrated-refined-detail.png')});
});

test('legacy A stays explicit and never fabricates a B curve',async({page})=>{
  const api=await mockProvider(page,'openrouter','shape');await openSource(page);await page.locator('#methodA').check();await page.locator('#configureKey').click();await page.locator('#apiKey').fill(syntheticKeys.openrouter);await page.locator('#analyze').click();await complete(page);
  expect(api.inferenceCalls()).toBe(1);await expect(page.locator('#automaticCurveStatus')).toContainText('旧形式');await expect(page.locator('#showAutomaticCurve')).toBeDisabled();await expect(page.locator('[data-journey-step="mask"]')).toHaveCount(0);
  const output:any=await jsonDownload(page);expect(output.outer_vertices_mm.map(({x,y}:Point)=>({x,y}))).toEqual(testShape.outer_vertices_mm);expect(output.provenance.automatic_curve).toBeUndefined();
});

test('real B trapezoid-with-hole sample records observed coverage without inventing an opening',async({page},info)=>{
  test.setTimeout(260000);await openSource(page);await openDetailsFor(page,'[data-sample="trapezoid-hole"]');await page.locator('[data-sample="trapezoid-hole"]').click();await sourceReady(page,'trapezoid-hole',{keepAutomaticCurves:true});
  await page.locator('#analyze').click();await complete(page);await expect(page.locator('#resultCurvePreview')).toBeVisible();
  const output:any=await jsonDownload(page),diagnostics=output.provenance.automatic_curve;
  const summary={sample:'genuine supplied trapezoid-hole photograph + real U2NetP',curveStatus:diagnostics?.status,lineCount:diagnostics?.lineCount,cubicCount:diagnostics?.cubicCount,observedHoleCount:output.geometry?.holes.length??output.holes_vertices_mm.length,maskThreshold:output.provenance.mask_threshold,epsilonMm:output.provenance.epsilon_mm};
  console.log('REAL_B_COVERAGE',JSON.stringify(summary));
  await info.attach('real-B-observed-hole-and-curve-coverage',{body:JSON.stringify(summary,null,2),contentType:'application/json'});
  if(summary.observedHoleCount===0)await expect(page.locator('#warnings')).toContainText('穴');
  if(output.geometry){expect(output.geometry.holes.length).toBe(output.provenance.original_dense_geometry_mm.holes.length);expect(diagnostics.maxErrorBoundMm).toBeLessThanOrEqual(diagnostics.toleranceMm);}
  await page.locator('#showDenseContour').check();await page.locator('#journeySkip').click();await page.locator('#automaticCurveResult').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('automatic-real-B-trapezoid-hole-observation.png'),fullPage:true});
  await page.locator('#automaticCurveResult').screenshot({path:info.outputPath('automatic-real-B-trapezoid-hole-detail.png')});
});

// TEST-ONLY worker result. This verifies integration of a known rounded raster
// contour through the real traceMask -> fit -> overlay -> export path. It is
// explicitly NOT evidence that U2NetP or the photograph detected this outline.
test('TEST-ONLY rounded mask produces full-contour Beziers automatically without a handle edit',async({page,context},info)=>{
  await context.route('**/assets/segmentation.worker-*.js',route=>route.fulfill({contentType:'application/javascript',body:`
    self.onmessage=()=>{
      const width=320,height=320,probabilities=new Float32Array(width*height);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const px=(x+.5)*250/width,py=(y+.5)*170/height;
        const outer=(px>=40&&px<=150&&py>=40&&py<=130)||(px>=150&&Math.hypot(px-150,py-85)<=45);
        const hole=Math.hypot(px-95,py-85)<12;
        probabilities[y*width+x]=outer&&!hole?1:0;
      }
      self.postMessage({result:{probabilities,width,height,elapsedMs:0,timingsMs:{modelLoad:0,preprocess:0,inference:0,normalize:0,total:0}}},[probabilities.buffer]);
    };`}));
  await openSource(page);await page.locator('#analyze').click();await complete(page);await expect(page.locator('#automaticCurveResult')).toHaveAttribute('data-state','fitted');
  const output=await jsonDownload(page),meta=output.provenance.automatic_curve;
  expect(meta.source).toBe('traceMask.rawGeometry_before_simplification');expect(meta.cubicCount).toBeGreaterThan(0);expect(meta.lineCount).toBeGreaterThan(0);expect(output.geometry.holes).toHaveLength(1);
  expect(ringVertices(output.geometry).some(p=>p.outgoing||p.incoming)).toBe(true);expect(meta.maxErrorBoundMm).toBeLessThanOrEqual(meta.toleranceMm);
  expect(await page.locator('#resultCurvePreview [data-result-outline]').getAttribute('d')).toContain('C ');await expect(page.locator('#edges')).toContainText('曲線長');await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await textDownload(page,'#exportSvg')).toContain('C ');
  await page.locator('#showDenseContour').check();await page.locator('#journeySkip').click();
  await page.locator('#automaticCurveResult').evaluate(node=>{const banner=document.createElement('p');banner.textContent='TEST ONLY · 合成マスクの結合テスト。写真・実モデルの認識精度の証拠ではありません。';banner.setAttribute('style','padding:12px;background:#fff0d1;color:#753900;font-weight:bold');node.prepend(banner);});
  await page.locator('.result-card').screenshot({path:info.outputPath('TEST-ONLY-rounded-B-mask-automatic-curves.png')});
  await page.locator('#automaticCurveResult').screenshot({path:info.outputPath('TEST-ONLY-rounded-B-mask-automatic-curves-detail.png')});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1);expect(overflow).toBe(false);
});


test('synthetic circle photograph runs real marker detection and ONNX into automatic curves',async({page},info)=>{
  test.setTimeout(260000);await openSource(page);await openDetailsFor(page,'[data-sample="circle-plate"]');await page.locator('[data-sample="circle-plate"]').click();await sourceReady(page,'circle-plate',{keepAutomaticCurves:true});
  await page.locator('#analyze').click();await complete(page);const output=await jsonDownload(page),meta=output.provenance.automatic_curve;
  expect(output.provenance.method).toBe('U2NetP-ONNX-WASM');expect(output.provenance.source_image).toBe('circle-plate');expect(output.provenance.inference_elapsed_ms).toBeGreaterThan(0);expect(output.provenance.stage_timings_ms.inference).toBeGreaterThan(0);
  expect(meta.status).toBe('fitted');expect(meta.cubicCount).toBeGreaterThan(0);expect(meta.source).toBe('traceMask.rawGeometry_before_simplification');expect(meta.maxErrorBoundMm).toBeLessThanOrEqual(meta.toleranceMm);
  expect(output.provenance.original_dense_geometry_mm.outer.length).toBeGreaterThan(output.geometry.outer.length);expect(await page.locator('#resultCurvePreview [data-result-outline]').getAttribute('d')).toContain('C ');await expect(page.locator('#edges')).toContainText('曲線長');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('#showDenseContour').check();await page.locator('#journeySkip').click();await expect(page.locator('#curveResultDetail')).toContainText('合成検証画像');
  console.log('REAL_CIRCLE_B',JSON.stringify({raw:meta.rawPointCount,anchors:meta.anchorCount,lines:meta.lineCount,cubics:meta.cubicCount,bound:meta.maxErrorBoundMm,holes:output.geometry.holes.length,inferenceMs:output.provenance.stage_timings_ms.inference,measuredAreaMm2:output.measurement.area_approx_mm2,measuredPerimeterMm:output.measurement.outer_length_mm,syntheticAnalyticAreaMm2:Math.PI*55*55,syntheticAnalyticPerimeterMm:2*Math.PI*55}));
  await page.locator('#automaticCurveResult').screenshot({path:info.outputPath('real-ONNX-circle-synthetic-photo-automatic-curve-detail.png')});await page.screenshot({path:info.outputPath('real-ONNX-circle-synthetic-photo-automatic-curve.png'),fullPage:true});
});
