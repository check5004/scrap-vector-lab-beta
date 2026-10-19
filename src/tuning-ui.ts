import { canvas, type Board, type MaskResult } from './vision';
import { type Geometry } from './geometry';

export const tuningPanelHtml = `<section id="tunePanel" class="panel tune-panel" aria-label="ベータの閾値自動調整"><div class="tune-head"><div><span class="eyebrow">BETA · BOUNDED SEARCH</span><h2>輪郭に合う設定を探す</h2><p>実際のAIマスクから候補を比較。スケールと撮影画像は固定します。</p></div><span class="pill">端末内 / ¥0</span></div><div class="tune-controls"><button id="autoTune" class="primary" disabled>閾値・εを自動調整</button><button id="tuneStop" disabled>調整を中止</button><label class="confirm"><input id="autoRecover" type="checkbox" checked><span>設定が無効なとき、端末内で復旧候補を探す</span></label></div><p id="tuneStatus" class="tune-status" role="status" aria-live="polite">未実行。前景閾値 0.10〜0.90 / εは現在値以下を探索します。</p><p class="hint">数値指標は輪郭の安定性と元マスクの保持率です。写真との一致率や計測精度ではありません。穴・細部の見落としや誤検出は、安定した候補にも残ります。</p><div id="tuneBefore" class="tune-before hidden"><img id="tuneBeforeImage" alt="調整前の輪郭"><div><strong>調整前の結果</strong><p id="tuneBeforeMetrics" class="hint"></p><button id="tuneRestore">調整前に戻す</button></div></div><div id="tuneCandidates" class="tune-candidates"></div><details class="tune-llm"><summary>写真と候補をLLMで見比べる <span class="badge">任意 · 外部API</span></summary><p id="reviewTarget" class="provider-target"></p><p class="hint">補正済みの写真と候補のマスク・輪郭画像を送信します。LLMの判定にも誤りがあります。再調整は同じAIマスクの閾値・εだけで行い、穴を生成したり実寸を変えたりしません。</p><div class="tune-review-settings"><label class="field">API呼出し上限<select id="reviewMaxCalls"><option value="1">1回</option><option value="2" selected>2回</option><option value="3">3回</option></select></label><button id="reviewKeys">接続先・キーを設定</button></div><label class="confirm"><input id="reviewConsent" type="checkbox"><span id="reviewConsentText"></span></label><button id="reviewRun" class="full" disabled>LLM評価・再調整を開始</button><p id="reviewStatus" class="tune-status" role="status">LLM評価は未実行です。</p><p id="reviewUsage" class="hint">開始前: API呼出し 0回。各回の出力上限1,200トークン。ドル上限の保証ではありません。料金が応答に含まれない場合は不明と表示します。取消後も送信済み処理の料金は発生し得ます。</p></details><details><summary>探索の数値記録</summary><pre id="tuneDetails" class="tune-details">未実行</pre></details></section>`;

/** One real photograph and overlays in the same calibrated plane; never truth-derived. */
export function candidateOverlay(source: HTMLCanvasElement, board: Board, mask: MaskResult, geometry: Geometry, threshold: number): string {
  const scale = Math.min(1, 900 / Math.max(source.width,source.height));
  const c = canvas(Math.max(1,Math.round(source.width*scale)), Math.max(1,Math.round(source.height*scale)));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source,0,0,c.width,c.height);
  const m = canvas(mask.width,mask.height), mc=m.getContext('2d')!, pixels=mc.createImageData(mask.width,mask.height);
  for(let i=0;i<mask.probabilities.length;i++) if(mask.probabilities[i]>=threshold) {
    pixels.data.set([30,210,150,70],i*4);
  }
  mc.putImageData(pixels,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(m,0,0,c.width,c.height);
  const x=c.width/board.width,y=c.height/board.height;
  for(const [index,ring] of [geometry.outer,...geometry.holes].entries()) {
    ctx.beginPath();ring.forEach((p,i)=>i?ctx.lineTo(p.x*x,p.y*y):ctx.moveTo(p.x*x,p.y*y));ctx.closePath();
    ctx.strokeStyle=index?'#ff77bc':'#fff6af';ctx.lineWidth=2;ctx.stroke();
  }
  return c.toDataURL('image/jpeg',0.86);
}
export function reviewPhotograph(source:HTMLCanvasElement):string {
  const scale=Math.min(1,900/Math.max(source.width,source.height));
  const c=canvas(Math.max(1,Math.round(source.width*scale)),Math.max(1,Math.round(source.height*scale)));
  c.getContext('2d')!.drawImage(source,0,0,c.width,c.height);
  return c.toDataURL('image/jpeg',0.86);
}
