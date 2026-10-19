import "./style.css";
import "./auto-tune.css";
import { APP_BUILD, APP_VERSION } from "./build-info";
import { tuningPanelHtml, candidateOverlay, reviewPhotograph } from "./tuning-ui";
import { mergeSearchResults } from "./tuning-state";
import { searchMaskCandidates, candidateSearchDiagnostics, type Candidate, type SearchResult } from "./auto-tune";
import { reviewCandidates, runReviewLoop, type ReviewCandidate, type ReviewAttempt, type CandidateReview } from "./candidate-review";
import { MeasurementJourney } from "./journey";
import {
  type Geometry,
  type Point,
  buildMeasurement,
  createSvg,
  createDxf,
  createJson,
  validateGeometry,
  cloneGeometry,
  nearAxisSnap,
  geometryArea,
  edgeMeasurements,
  compareGeometry,
} from "./geometry";
import {
  PRESETS,
  customBoard,
  loadImage,
  imageCanvas,
  inspectMarkers,
  assertMarkerReport,
  homographyDetails,
  rectify,
  gridImage,
  traceMask,
  simplifyMaskTrace,
  type Board,
  type MaskResult,
  type Marker,
  type MarkerDetectionReport,
} from "./vision";
import {
  segment,
  inferLunaProvider,
  PROVIDERS,
  ProviderError,
  validateProviderKey,
  type Provider,
} from "./ai";
import {
  DebugPanel,
  markerDebugImage,
  maskDebugImage,
  geometryDebugImage,
  type DebugStage,
} from "./debug";
import { createProviderKeyStore, providerStorageKey, type KeyStorageStatus } from "./key-storage";
type Mode = "A" | "B" | "C";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const base = import.meta.env.BASE_URL;
const html = `<div id="progress" class="progressbar hidden"></div><header class="top"><div class="brand"><div class="logo">⌑</div><div><strong>端材ラボ</strong><small>SCRAP VECTOR LAB · BETA / <span id="appVersion">${APP_VERSION}</span></small></div></div><div class="topnote">写真から、ものづくりの次の一枚へ。</div><span class="pill">BETA · 自動調整</span></header><p class="beta-notice">自動調整ベータ · 本番とは別の配信です。<a href="https://check5004.github.io/scrap-vector-lab/" target="_blank" rel="noopener">通常版を開く ↗</a></p><section class="intro"><div><div class="eyebrow">PHOTO → PLANE → VECTOR</div><h1>端材のかたちを、寸法に。</h1><p>4つのマーカーで平面補正。AIで輪郭を抽出し、指先で仕上げる。</p></div><div class="flow"><span><b>01</b>撮影</span><span><b>02</b>AI抽出</span><span><b>03</b>編集・書き出し</span></div></section><main class="layout"><aside class="panel sidebar"><section class="section"><h2 class="sectiontitle">01　写真を用意<span>INPUT</span></h2><input id="file" type="file" accept="image/*" aria-label="写真ライブラリ・ファイルから選ぶ" class="hidden"><input id="cameraFile" type="file" accept="image/*" capture="environment" aria-label="カメラで撮影" class="hidden"><div class="stack"><button id="upload" type="button" class="full primary" aria-controls="file">＋ 写真ライブラリ・ファイルから選ぶ</button><button id="camera" type="button" class="full" aria-controls="cameraFile">カメラで撮影</button></div><p class="hint">ID 0〜3をすべて写してください。<br>写真はMode Bでは端末内だけで処理。</p><p class="sample-label">AI画像で生成した鋼材の質感</p><div class="samples"><button class="sample ai-sample" data-sample="ai-l-shape">AI · L字型</button><button class="sample ai-sample" data-sample="ai-notched">AI · 凹型</button><button class="sample ai-sample" data-sample="ai-trapezoid-hole">AI · 台形＋穴</button></div><p class="sample-origin">AIで生成した鋼材の質感を、寸法が既知の形状・台紙に合成。マーカーは正規のコードです。実物を撮影した写真ではありません。</p><p class="sample-label">従来の合成写真 · 比較用</p><div class="samples"><button class="sample" data-sample="l-shape"><svg viewBox="0 0 30 23"><path d="M2 2H28V10H15V22H2Z"/></svg>L字型</button><button class="sample" data-sample="notched"><svg viewBox="0 0 30 23"><path d="M2 2H10V12H20V2H28V22H2Z"/></svg>凹型</button><button class="sample" data-sample="trapezoid-hole"><svg viewBox="0 0 30 23"><path fill-rule="evenodd" d="M8 2H23L29 22H1ZM20 12a5 5 0 1 0 -10 0a5 5 0 1 0 10 0"/></svg>台形＋穴</button></div></section><section class="section"><h2 class="sectiontitle">02　基準スケール<span>CALIBRATION</span></h2><label class="field">規定の内側角の間隔<select id="preset"><option value="a4">A4用紙 · 250 × 170 mm</option><option value="medium">中型台 · 500 × 500 mm</option><option value="large">大型台 · 1000 × 1000 mm</option><option value="custom">カスタム寸法</option></select></label><div id="custom" class="row hidden"><label class="field">横 mm<input id="width" type="number" value="2000" min="10" max="10000"></label><label class="field">縦 mm<input id="height" type="number" value="1000" min="10" max="10000"></label></div><button id="rectify" class="full">マーカー検出・平面補正</button><p id="scale" class="hint">2500 × 1700 px · 0.100 mm/px</p><div class="row" style="margin-top:12px"><a class="hint" href="${base}print/a4-marker-sheet.svg" download>A4台紙 SVG ↗</a><a class="hint" href="${base}print/a4-marker-sheet.png" download>PNG ↗</a><button id="print" style="padding:5px 8px;min-height:30px;font-size:10px">印刷</button></div><p class="hint">A4横・100% / 実際のサイズで印刷。<br>100 mmの目盛りを定規で実測してください。<br>切り離したマーカーも台紙と同じ向きに配置。</p></section><section class="section advanced"><h2 class="sectiontitle">03　AIでベクター化<span>INFERENCE</span></h2><button id="runB" class="full primary" disabled>B · 端末内AIで輪郭を抽出</button><p class="hint">U²-NetP / ONNX · 実推論 · API費用なし<br>320 × 320のAIマスクをミリ座標へ変換</p><p class="warn">既知の制限: 従来の穴サンプルでは、直径40 mmの穴を見落とします。Cで穴を描いて修正できます。</p><label class="field" style="margin-top:15px">直線化の許容差 ε <b id="epsilonValue">1.0 mm</b><input id="epsilon" type="range" min="0.5" max="10" step="0.001" value="1"></label><details><summary>マスクの閾値を調整</summary><label class="field">前景確率 <b id="thresholdValue">0.50</b><input id="threshold" type="range" min="0.1" max="0.9" step="0.001" value="0.5"></label></details><details style="margin-top:18px"><summary>A · GPT-6 Lunaで輪郭を推論 <span class="badge">外部API</span></summary><label class="field" style="margin-top:12px">API接続先<select id="provider"><option value="openrouter" selected>OpenRouter（OpenRouterのキー）</option><option value="openai">OpenAI直接（OpenAIのキー）</option></select></label><p id="providerTarget" class="provider-target"></p><label class="field"><span id="apiKeyLabel">OpenRouter APIキー（このブラウザに保存）</span><input id="apiKey" type="password" placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false" aria-describedby="keyStorageHelp keyStorageStatus"></label><p id="keyStorageStatus" class="provider-note" role="status" aria-live="polite"></p><p id="keyStorageHelp" class="hint">ベータ専用の保存名を使い、本番の保存キーは読込・移行・削除しません。同じホスト名のため完全なセキュリティ隔離ではありません。入力したキーは接続先ごとに、この端末・ブラウザのlocalStorageへ自動保存され、リロード後も復元されます。共有端末では使わず、利用後は削除してください。暗号化保存ではなく、同じサイト（ホスト名）のページや拡張機能から読まれる可能性があります。別の端末・ブラウザには同期しません。プライベートモードやサイトデータ削除では失われる場合があります。保存だけではAPIに送信しません。</p><p id="keyValidation" class="provider-note" role="status"></p><button id="clearKey" class="full">この接続先の保存キーを削除</button><label class="field" style="margin-top:12px">画像の方眼間隔<select id="gridstep"><option value="10">10 mm</option><option value="25">25 mm</option><option value="50">50 mm</option><option value="100">100 mm</option></select></label><label class="confirm"><input id="consent" type="checkbox"><span id="consentText"></span></label><button id="runA" class="full" disabled>A · GPT-6 Lunaで推論</button><p class="hint">ブラウザでのキー入力は信頼する端末・このPoC限定でご利用ください。本番運用ではサーバー経由を推奨。キーなしでは実行しません。接続先ごとのキーが必要です。接続先変更時は、その接続先の保存キーだけを復元し、送信の確認を解除します。実行時に提供状況を確認。失敗時の代替推論・架空結果はありません。</p></details></section></aside><section class="workspace"><section id="journey-root" class="panel" aria-label="写真から寸法までの連続表示"></section>${tuningPanelHtml}<div class="panel editor-panel"><div class="editor-disclosure"><div><b>編集・比較</b><span>A / B / C · 実寸の確認</span></div><button id="toggleEditor" aria-expanded="false" aria-controls="editorSurface">計測キャンバスを開く</button></div><div id="editorSurface" class="hidden"><div class="canvashead"><div class="legend"><b>MEASUREMENT CANVAS</b><label><input type="checkbox" id="showA" checked><i class="dot a"></i>A</label><label><input type="checkbox" id="showB" checked><i class="dot b"></i>B</label><label><input type="checkbox" id="showC" checked><i class="dot c"></i>C</label></div><select id="view" aria-label="背景表示"><option value="rectified">補正後</option><option value="photo">撮影画像</option><option value="mask">AIマスク</option><option value="grid">方眼</option></select></div><div class="canvaswrap"><svg id="editor" viewBox="0 0 250 170" role="img" aria-label="端材の輪郭と編集可能な頂点"></svg></div><div class="canvasfooter"><span id="sourceLabel">SAMPLE / 合成写真を読み込み中</span><span id="markerLabel">MARKERS —</span></div></div><div class="editbar"><button id="editC" disabled>Cへコピーして編集</button><button id="undo" disabled>↶ 戻す</button><button id="delete" disabled>頂点を削除</button><button id="snap" disabled>直角に整列 ±5°</button><button id="drawHole" disabled>＋ 穴を描く</button><button id="drawOuter">外周を手描き</button><button id="finishDraw" class="hidden">図形を確定</button><button id="cancelDraw" class="hidden">描画を中止</button><span id="selected" class="selectednum"></span></div></div><div id="status" role="status" aria-live="polite" class="status">合成写真を読み込み中…</div><p class="hint"><a href="#debugPanel">マーカー認識・処理途中の画像を見る ↓</a></p><p class="hint">Cモード: ピンをドラッグ、辺をタップして頂点追加。ピンを選んで削除、またはダブルタップ。輪郭が交差する編集は確定できません。</p><section id="debugPanel" class="panel debug-panel"></section><div class="panel compare"><h2>検証ベンチ <span class="hint">/ 合成写真の既知寸法との比較</span></h2><div id="benchmark" class="benchgrid"></div><p class="hint">正解は評価だけに使用し、AIの入力・予測には使用しません。曲線は多角形近似。誤差はこの合成画像での結果で、実物の精度保証ではありません。</p></div></section><aside class="panel results"><section class="section"><h2 class="sectiontitle">計測結果<span>MM UNITS</span></h2><div class="tabs"><button data-mode="A">A · LLM</button><button data-mode="B" class="active">B · AI</button><button data-mode="C">C · 編集</button></div><p class="hint" style="margin-top:18px">正味面積（外周 − 穴）</p><div class="summaryvalue"><span id="area">—</span><small>mm²</small></div><div class="submetric"><span>外周の頂点</span><b id="vertices">—</b></div><div class="submetric"><span>検出した穴</span><b id="holes">—</b></div><div class="submetric"><span>外周長</span><b id="perimeter">— mm</b></div><div id="warnings"></div></section><section class="section"><h2 class="sectiontitle">各辺の寸法<span>LENGTH / ANGLE</span></h2><div id="edges" class="edge-list"><p class="hint">AI抽出後に表示されます。</p></div></section><section class="section exports"><h2 class="sectiontitle">実寸で書き出す<span>EXPORT 1:1</span></h2><div class="stack"><button id="exportSvg" disabled>SVG　↗</button><button id="exportDxf" disabled>DXF　↗</button><button id="exportJson" disabled>JSON　↗</button></div><p class="hint">現在選択中のモードを出力。<br>SVG: mm + 寸法レイヤー<br>DXF: mm / 閉じたLWPOLYLINE</p><a class="hint" href="https://github.com/check5004/scrap-vector-lab/tree/${APP_BUILD.source_commit === 'local' ? 'beta/auto-threshold-20261019' : APP_BUILD.source_commit}" target="_blank" rel="noopener">ソース・検証手順 ↗</a></section></aside></main><footer class="footer"><p>検証用ツールです。0.1 mm/pxは画像の刻み幅であり、計測精度ではありません。厚み・反り・カメラのレンズ歪み・斜め撮影・印刷倍率で誤差が生じます。マーカーと測定面を同じ平面にし、重要な寸法は必ず実測してください。AIは穴や細部を見落とすことがあります。</p><span>DICT_4X4_50<br>0 TL · 1 TR · 2 BR · 3 BL</span></footer>`;
$("app").innerHTML = html;
let board: Board = { ...PRESETS.a4 },
  source: HTMLCanvasElement | undefined,
  flat: HTMLCanvasElement | undefined,
  markers: Marker[] = [];
let mask: MaskResult | undefined,
  maskUrl = "",
  photoUrl = "",
  flatUrl = "",
  gridUrl = "";
let activeRequest: AbortController | undefined;
let pipelineAbort: AbortController | undefined;
let active: Mode = "B",
  busy = false,
  sampleId = "",
  truth: Geometry | undefined,
  sourceName = "";
const geometries: Partial<Record<Mode, Geometry>> = {},
  provenance: Partial<Record<Mode, Record<string, unknown>>> = {},
  warnings: Partial<Record<Mode, string[]>> = {};
let tuneEpoch = 0;
let tuneResult: SearchResult | undefined;
let tuneSelectedId: string | undefined;
let tuneReview: Record<string, unknown> | undefined;
let tuneRunActive = false;
let pipelineFinishMessage: string | undefined;
let tuneOriginal: { geometry:Geometry; provenance:Record<string,unknown>|undefined; warnings:string[]|undefined; threshold:number; epsilon:number } | undefined;
const tuneImages = new Map<string,string>();
let undo: Geometry[] = [];
let selected: { ring: number; index: number } | undefined;
let dragging:
  | { ring: number; index: number; before: Geometry; moved: boolean }
  | undefined;
let drawing: { kind: "outer" | "hole"; points: Point[] } | undefined;
const editor = $<SVGSVGElement & HTMLElement>("editor");
let journeyToken: number | undefined;
let journeyMarkerReport: MarkerDetectionReport | undefined;
const journey = new MeasurementJourney($("journey-root"), {
  runAll: () => void guarded(async () => {
    focusJourney();
    readCustomBoard();
    await calibrate();
    await runModeB();
  }),
  onEdit: () => revealEditor(),
  onCancel: () => { pipelineAbort?.abort(); activeRequest?.abort(); },
});
function focusJourney() {
  $("editorSurface").classList.add("hidden");
  $("toggleEditor").setAttribute("aria-expanded", "false");
  $("toggleEditor").textContent = "計測キャンバスを開く";
  $("journey-root").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
}
function revealEditor(message = "編集・比較のため説明再生を停止しました。") {
  journey.stopForEdit(message);
  $("editorSurface").classList.remove("hidden");
  $("toggleEditor").setAttribute("aria-expanded", "true");
  $("toggleEditor").textContent = "計測キャンバスを閉じる";
  renderCanvas();
}
$("toggleEditor").onclick = () => {
  if ($("editorSurface").classList.contains("hidden")) revealEditor();
  else {
    $("editorSurface").classList.add("hidden");
    $("toggleEditor").setAttribute("aria-expanded", "false");
    $("toggleEditor").textContent = "計測キャンバスを開く";
  }
};
const debug = new DebugPanel(
  $("debugPanel"),
  () => {
    pipelineAbort?.abort();
    activeRequest?.abort();
  },
  () =>
    void guarded(async () => {
      readCustomBoard();
      await calibrate();
      await runModeB();
    }),
);
const provider = () => $<HTMLSelectElement>("provider").value as Provider;
const keyStore = createProviderKeyStore();
function showKeyStorageStatus(result: KeyStorageStatus) {
  const messages: Record<KeyStorageStatus, string> = {
    loaded: "この接続先の保存キーを復元しました。送信するには下の確認が必要です。",
    empty: "この接続先の保存キーはありません。入力すると自動保存します。",
    saved: "このブラウザに保存しました。リロード後も復元されます。",
    cleared: "この接続先の保存キーを削除しました。",
    "invalid-cleared": "キーの形式または保存データが不正です。以前の保存値は削除しました。",
    unavailable: "ブラウザの保存領域を利用できません。入力したキーはこのタブだけで使用します。",
    "save-failed": "保存できませんでした。以前の保存値は削除し、入力したキーはこのタブだけで使用します。",
    "clear-failed": "このタブのキーは消去しましたが、保存領域の削除を確認できません。ブラウザのサイトデータを削除してください。再読み込みすると古いキーが戻る可能性があります。",
    "unsupported-provider": "未対応の接続先です。キーは保存・復元しません。",
  };
  $("keyStorageStatus").textContent = messages[result];
  $("keyStorageStatus").classList.toggle("warn", ["unavailable", "save-failed", "clear-failed", "invalid-cleared"].includes(result));
}
function restoreProviderKey() {
  $<HTMLInputElement>("reviewConsent").checked = false;
  const result = keyStore.load(provider());
  $<HTMLInputElement>("apiKey").value = result.key;
  $<HTMLInputElement>("consent").checked = false;
  showKeyStorageStatus(result.status);
  updateProviderUI();
  updateButtons();
}
function processing(message: string) {
  status(message);
  debug.progress(message);
  journey.setProcessing(message, "running", journeyToken);
}
function readCustomBoard() {
  if ($<HTMLSelectElement>("preset").value === "custom")
    board = customBoard(
      Number($<HTMLInputElement>("width").value),
      Number($<HTMLInputElement>("height").value),
    );
}
function updateProviderUI() {
  const selected = provider(),
    settings = PROVIDERS[selected];
  $("providerTarget").textContent = `${settings.model} → ${settings.endpoint}`;
  $("reviewTarget").textContent = `${settings.name} · ${settings.model}`;
  $("reviewConsentText").textContent = `補正画像と候補画像を${settings.name}${selected === "openrouter" ? "およびその推論提供先" : ""}へ送り、上限回数内で有料の評価・再調整を実行することを確認しました。`;
  $("apiKeyLabel").textContent =
    `${settings.name} APIキー（このブラウザに保存）`;
  $<HTMLInputElement>("apiKey").placeholder =
    selected === "openrouter" ? "sk-or-v1-…" : "sk-…";
  $("consentText").textContent =
    selected === "openrouter"
      ? "写真・寸法をOpenRouterおよびその推論提供先に送り、自分のAPI利用料が発生することを確認しました。"
      : "写真・寸法をOpenAIに送り、自分のAPI利用料が発生することを確認しました。";
  const key = $<HTMLInputElement>("apiKey").value;
  $("keyValidation").textContent = key.trim()
    ? (validateProviderKey(selected, key) ??
      "キーの形式は接続先と一致しています。有効性は実行時に確認します。")
    : "";
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const fmt = (v: number, d = 1) =>
  v.toLocaleString("ja-JP", {
    maximumFractionDigits: d,
    minimumFractionDigits: d,
  });
function status(s: string, error = false) {
  $("status").textContent = s;
  $("status").classList.toggle("error", error);
}
function setBusy(v: boolean) {
  busy = v;
  journey.setBusy(v);
  $("progress").classList.toggle("hidden", !v);
  updateButtons();
  document
    .querySelectorAll<HTMLButtonElement>(".sample,#upload,#camera,#rectify")
    .forEach((b) => (b.disabled = v));
  $<HTMLSelectElement>("preset").disabled = v;
  $<HTMLSelectElement>("provider").disabled = v;
  for (const id of [
    "file", "cameraFile", "width", "height", "epsilon", "threshold", "gridstep",
  ])
    $<HTMLInputElement>(id).disabled = v;
}
function updateButtons() {
  $<HTMLButtonElement>("tuneRestore").disabled = busy || !!drawing || !!dragging || !tuneOriginal;
  $<HTMLButtonElement>("autoTune").disabled = busy || !flat || !!drawing || !!dragging;
  $<HTMLButtonElement>("tuneStop").disabled = !busy || !tuneRunActive;
  $<HTMLButtonElement>("reviewRun").disabled = busy || !!drawing || !!dragging || !tuneResult?.candidates.length ||
    !!validateProviderKey(provider(), $<HTMLInputElement>("apiKey").value) || !$<HTMLInputElement>("reviewConsent").checked;
  $<HTMLSelectElement>("reviewMaxCalls").disabled = busy;
  $<HTMLInputElement>("autoRecover").disabled = busy;
  document.querySelectorAll<HTMLButtonElement>("[data-apply-candidate]").forEach(button=>button.disabled=busy || !!drawing || !!dragging);
  for (const id of ["runB", "drawOuter"])
    $<HTMLButtonElement>(id).disabled = busy || !flat;
  $<HTMLButtonElement>("runA").disabled =
    busy ||
    !flat ||
    !!validateProviderKey(provider(), $<HTMLInputElement>("apiKey").value) ||
    !$<HTMLInputElement>("consent").checked;
  const g = geometries[active],
    valid = !!g && validateGeometry(g).valid;
  $<HTMLButtonElement>("editC").disabled = busy || !g || active === "C";
  for (const id of ["exportSvg", "exportDxf", "exportJson"])
    $<HTMLButtonElement>(id).disabled =
      busy || !valid || !!drawing || !!dragging;
  for (const id of ["snap", "drawHole"])
    $<HTMLButtonElement>(id).disabled =
      busy || active !== "C" || !geometries.C || !!drawing || !!dragging;
  $<HTMLButtonElement>("delete").disabled =
    busy || active !== "C" || !selected || !!drawing || !!dragging;
  $<HTMLButtonElement>("undo").disabled =
    busy || !undo.length || active !== "C";
  $("finishDraw").classList.toggle("hidden", !drawing);
  $("cancelDraw").classList.toggle("hidden", !drawing);
}
function resetResults() {
  resetTuning();
  for (const m of ["A", "B", "C"] as Mode[]) {
    delete geometries[m];
    delete provenance[m];
    delete warnings[m];
  }
  mask = undefined;
  maskUrl = "";
  undo = [];
  selected = undefined;
  drawing = undefined;
  dragging = undefined;
  render();
}
function ringPath(r: Point[]) {
  return r.length ? `M${r.map((p) => `${p.x},${p.y}`).join("L")}Z` : "";
}
function allRings(g: Geometry) {
  return [g.outer, ...g.holes];
}
function renderCanvas() {
  const view = $<HTMLSelectElement>("view").value;
  let bg = flatUrl;
  if (view === "photo") bg = photoUrl;
  else if (view === "mask") bg = maskUrl;
  else if (view === "grid") bg = gridUrl;
  const photo = view === "photo";
  const w = photo && source ? source.width : board.width,
    h = photo && source ? source.height : board.height;
  editor.setAttribute("viewBox", `0 0 ${w} ${h}`);
  let html = bg
    ? `<image href="${bg}" x="0" y="0" width="${w}" height="${h}"/>`
    : `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="${w / 28}" fill="#8b9187">${view === "mask" ? "AIマスクは抽出後に表示" : "写真を選んでください"}</text>`;
  if (photo) {
    for (const m of markers) {
      html += `<polygon points="${m.corners.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#f15d2f" stroke-width="${w / 500}"/><text x="${m.corners[0].x}" y="${m.corners[0].y - 8}" font-size="${w / 60}" fill="#b73f17">ID ${m.id}</text>`;
    }
  } else {
    const colors = { A: "#087b9d", B: "#d06625", C: "#234f35" },
      stroke = board.width / 900,
      font = board.width / 75,
      handle = board.width / 120,
      hitRadius = Math.max(
        handle,
        (18 * board.width) / Math.max(250, editor.clientWidth),
      );
    for (const mode of ["A", "B", "C"] as Mode[]) {
      const g = geometries[mode];
      if (!g || !$<HTMLInputElement>(`show${mode}`).checked) continue;
      html += `<path d="${allRings(g).map(ringPath).join("")}" fill="${mode === active ? colors[mode] + "12" : "none"}" fill-rule="evenodd" stroke="${colors[mode]}" stroke-width="${stroke * (mode === active ? 2 : 1.2)}" ${mode !== active ? 'stroke-dasharray="1.2 1"' : ""}/>`;
      if (mode === active) {
        allRings(g).forEach((ring, ri) => {
          ring.forEach((p, i) => {
            const q = ring[(i + 1) % ring.length],
              len = Math.hypot(q.x - p.x, q.y - p.y);
            html += `<text x="${(p.x + q.x) / 2}" y="${(p.y + q.y) / 2 - font * 0.7}" font-size="${font}" fill="${colors[mode]}" text-anchor="middle" stroke="#fffc" stroke-width="${font * 0.28}" paint-order="stroke">${fmt(len)} mm</text>`;
            if (mode === "C") {
              html += `<line data-edge="${ri},${i}" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="transparent" stroke-width="${handle * 3}" style="cursor:crosshair"/>`;
            }
          });
        });
        if (mode === "C")
          allRings(g).forEach((ring, ri) =>
            ring.forEach((p, i) => {
              html += `<circle data-pin="${ri},${i}" cx="${p.x}" cy="${p.y}" r="${hitRadius}" fill="transparent" style="cursor:grab"><title>頂点 ${i + 1} をドラッグ</title></circle><circle cx="${p.x}" cy="${p.y}" r="${handle}" pointer-events="none" fill="${selected?.ring === ri && selected?.index === i ? "#e19152" : "#fff"}" stroke="${colors[mode]}" stroke-width="${stroke * 1.8}" style="cursor:grab"/><text x="${p.x + handle * 1.4}" y="${p.y - handle * 1.3}" font-size="${font * 0.7}" fill="#31573b">${ri ? `H${ri}.` : ""}${i + 1}</text>`;
            }),
          );
      }
    }
    if (drawing) {
      html += `<polyline points="${drawing.points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#2c633c" stroke-width="${stroke * 2}" stroke-dasharray="2 1"/>`;
      for (const p of drawing.points)
        html += `<circle cx="${p.x}" cy="${p.y}" r="${handle}" fill="#2c633c"/>`;
    }
  }
  editor.innerHTML = html;
}
function render() {
  renderCanvas();
  document
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === active));
  const g = geometries[active];
  $("area").textContent = g ? fmt(geometryArea(g), 0) : "—";
  $("vertices").textContent = g ? `${g.outer.length}` : "—";
  $("holes").textContent = g ? `${g.holes.length}` : "—";
  $("perimeter").textContent = g
    ? `${fmt(g.outer.reduce((s, p, i) => s + Math.hypot(p.x - g.outer[(i + 1) % g.outer.length].x, p.y - g.outer[(i + 1) % g.outer.length].y), 0))} mm`
    : "— mm";
  $("edges").innerHTML = g
    ? allRings(g)
        .map((r, ri) =>
          r
            .map((p, i) => {
              const q = r[(i + 1) % r.length];
              return `<div class="edge-row"><span>${ri ? `H${ri} · ` : ""}${i + 1} → ${((i + 1) % r.length) + 1}</span><span>${fmt(Math.hypot(q.x - p.x, q.y - p.y))} mm <small>${fmt((Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI)}°</small></span></div>`;
            })
            .join(""),
        )
        .join("")
    : '<p class="hint">AI抽出後に表示されます。</p>';
  $("warnings").innerHTML = (warnings[active] ?? [])
    .map((w) => `<p class="warn">${esc(w)}</p>`)
    .join("");
  $("selected").textContent = selected
    ? `選択 ${selected.ring ? "穴" + selected.ring + " / " : ""}頂点 ${selected.index + 1}`
    : "";
  renderBench();
  updateButtons();
}
function renderBench() {
  const target = $("benchmark");
  target.innerHTML = (["A", "B", "C"] as Mode[])
    .map((m) => {
      const g = geometries[m];
      if (!truth)
        return `<div class="benchcard"><b>MODE ${m}</b><p>実写真には正解寸法がありません。定規・ノギスと比較してください。</p></div>`;
      if (g && !validateGeometry(g).valid)
        return `<div class="benchcard"><b>MODE ${m}</b><p>編集中の輪郭が交差しています。確定時に取り消されます。</p></div>`;
      if (!g)
        return `<div class="benchcard"><b>MODE ${m}</b><p>${m === "A" ? "API未実行" : m === "B" ? "AI未実行" : "未編集"}<br>予測値はまだありません。</p></div>`;
      const r = compareGeometry(g, truth);
      return `<div class="benchcard"><b>MODE ${m} · 境界平均誤差</b><div style="margin-top:8px"><strong>${fmt(r.boundary_mean_mm, 2)}</strong><span class="hint"> mm</span></div><p>境界最大 ${fmt(r.boundary_max_mm, 2)} mm<br>面積誤差 ${fmt(r.area_error_percent, 2)}%<br>穴 ${g.holes.length} / 正解 ${truth!.holes.length}<br>${r.edge_length_mae_mm === null ? "辺誤差: 対応不一致" : `辺平均誤差 ${fmt(r.edge_length_mae_mm, 2)} mm`}</p>${r.hole_count_mismatch ? '<p class="warn">穴の見落とし / 個数不一致</p>' : ""}</div>`;
    })
    .join("");
}
async function calibrate() {
  if (!source) throw Error("先に写真を選んでください。");
  flat = undefined;
  flatUrl = "";
  gridUrl = "";
  markers = [];
  journeyMarkerReport = undefined;
  $("markerLabel").textContent = "MARKERS —";
  resetResults();
  debug.reset();
  journeyToken = journey.begin(source, board);
  const token = journeyToken;
  journey.setProcessing("入力写真を確認しています", "running", token);
  const signal = pipelineAbort?.signal;
  await debug.checkpoint(
    {
      id: "input",
      title: "実際の入力写真",
      image: photoUrl,
      details: {
        source: sampleId || "user-upload",
        source_size_px: [source.width, source.height],
        sample_kind: sampleId.startsWith("ai-")
          ? "AI-generated texture + controlled geometric composite"
          : sampleId
            ? "deterministic synthetic fixture"
            : "user image",
        board_size_mm: { width_mm: board.width, height_mm: board.height },
      },
    },
    signal,
  );
  processing("ArUco ID 0〜3を検出中…");
  const report = await inspectMarkers(source);
  signal?.throwIfAborted();
  journeyMarkerReport = report;
  journey.setMarkers(report, token);
  $("markerLabel").textContent =
    `MARKERS ${report.markers.map((m) => m.id).join(" · ") || "なし"}${report.missingIds.length ? " / MISSING " + report.missingIds.join(", ") : ""}`;
  await debug.checkpoint(
    {
      id: "markers",
      title: "実際のArUco検出・候補",
      image: markerDebugImage(source, report),
      elapsedMs: report.elapsedMs,
      state:
        report.missingIds.length || report.duplicateIds.length
          ? "error"
          : "complete",
      details: {
        dictionary: "DICT_4X4_50",
        hamming_distance_allowed: 0,
        decoded: report.decodedMarkers,
        selected: report.markers,
        rejected_candidates: report.rejectedCandidates,
        missing_ids: report.missingIds,
        duplicate_ids: report.duplicateIds,
        candidate_count: report.candidateCount,
        source_size_px: report.sourceSize,
        detector_size_px: report.detectorSize,
        reference_corner_indices: [2, 3, 0, 1],
        legend:
          "green: decoded; amber dashed: undecoded candidates; red: selected reference corner",
      },
    },
    signal,
  );
  markers = assertMarkerReport(report);
  processing("4点から射影変換を計算中…");
  const started = performance.now(),
    pendingFlat = rectify(source, markers, board),
    elapsed = performance.now() - started;
  const pendingFlatUrl = pendingFlat.toDataURL("image/jpeg", 0.94);
  journey.setRectified(pendingFlat, homographyDetails(markers, board), token);
  await debug.checkpoint(
    {
      id: "rectified",
      title: "射影変換後の実画像",
      image: pendingFlatUrl,
      elapsedMs: elapsed,
      details: homographyDetails(markers, board),
    },
    signal,
  );
  const grid = makeGridStage(pendingFlat);
  await debug.checkpoint(grid.stage, signal);
  signal?.throwIfAborted();
  flat = pendingFlat;
  flatUrl = pendingFlatUrl;
  gridUrl = grid.stage.image!;
  $("markerLabel").textContent = "MARKERS 0 · 1 · 2 · 3 ✓";
  $<HTMLSelectElement>("view").value = "rectified";
  $("scale").textContent =
    `${board.pixelWidth} × ${board.pixelHeight} px · 横 ${(board.width / board.pixelWidth).toFixed(3)} / 縦 ${(board.height / board.pixelHeight).toFixed(3)} mm/px`;
  processing(
    "平面補正できました。「B · 端末内AI」で実際の輪郭抽出を試せます。",
  );
  render();
}
function makeGridStage(input: HTMLCanvasElement) {
  const started = performance.now(),
    step = Number($<HTMLSelectElement>("gridstep").value),
    image = gridImage(input, board, step),
    elapsedMs = performance.now() - started;
  return {
    image,
    stage: {
      id: "grid",
      title: "実際の方眼付き画像",
      image: image.toDataURL("image/jpeg", 0.9),
      elapsedMs,
      details: {
        grid_step_mm: step,
        board_size_mm: { width_mm: board.width, height_mm: board.height },
        note: "Mode A receives this image; Mode B receives rectified pixels without grid.",
      },
    } as DebugStage,
  };
}
async function guarded(fn: () => Promise<void>) {
  if (busy) return;
  pipelineAbort = new AbortController();
  pipelineFinishMessage = undefined;
  setBusy(true);
  debug.start();
  try {
    await fn();
    pipelineAbort.signal.throwIfAborted();
    journey.setProcessing(pipelineFinishMessage ?? "処理完了 · 説明再生とは別の実処理です", "complete", journeyToken);
  } catch (e) {
    const aborted =
      pipelineAbort.signal.aborted ||
      (e instanceof Error && e.name === "AbortError");
    const message = aborted
      ? "処理を中止しました。送信済みデータ・発生済みAPI料金は取り消せません。"
      : e instanceof Error
        ? e.message
        : String(e);
    status(message, !aborted);
    if (aborted) {
      journey.cancel("処理を中止しました。新しく処理するまで説明は再開しません。");
      journeyToken = undefined;
    }
    else journey.fail(message, journeyToken);
    if (e instanceof ProviderError)
      debug.fail(message, {
        provider: e.provider,
        stage: e.stage,
        http_status: e.status,
        error_code: e.code,
        endpoint: e.endpoint,
      });
    else if (aborted) debug.progress(message);
    else debug.fail(message);
  } finally {
    pipelineAbort = undefined;
    debug.finish();
    setBusy(false);
    render();
  }
}
function invalidateSource() {
  journey.reset();
  journeyToken = undefined;
  journeyMarkerReport = undefined;
  source = undefined;
  flat = undefined;
  markers = [];
  photoUrl = "";
  flatUrl = "";
  gridUrl = "";
  truth = undefined;
  $("markerLabel").textContent = "MARKERS —";
  $("sourceLabel").textContent = "新しい写真を読み込み中…";
  debug.reset();
  resetResults();
}
async function loadSample(id: string) {
  await guarded(async () => {
    invalidateSource();
    sampleId = id;
    sourceName = `${id.startsWith("ai-") ? "AI質感＋寸法管理した合成写真" : "合成写真"} / ${id}`;
    truth = undefined;
    board = { ...PRESETS.a4 };
    $<HTMLSelectElement>("preset").value = "a4";
    $("custom").classList.add("hidden");
    const img = await loadImage(
      `${base}samples/${id}.${id.startsWith("ai-") ? "jpg" : "png"}`,
    );
    pipelineAbort?.signal.throwIfAborted();
    source = imageCanvas(img);
    photoUrl = source.toDataURL("image/jpeg", 0.95);
    $("sourceLabel").textContent = sourceName;
    document
      .querySelectorAll<HTMLButtonElement>("[data-sample]")
      .forEach((b) => b.classList.toggle("active", b.dataset.sample === id));
    await calibrate();
    const response = await fetch(`${base}samples/${id}.truth.json`, {
      signal: pipelineAbort?.signal,
    });
    if (response.ok) {
      const t = await response.json();
      pipelineAbort?.signal.throwIfAborted();
      truth = t.geometry ?? {
        outer: t.outer_vertices_mm,
        holes: t.holes_vertices_mm ?? [],
      };
      if (!validateGeometry(truth!).valid) {
        truth = undefined;
        status("正解データの形式を検証できません。推論は利用できます。", true);
      }
    }
  });
}
type VectorResult = {
  r: ReturnType<typeof simplifyMaskTrace>;
  rawGeometry: Geometry;
  epsilon: number;
  threshold: number;
};
function* vectorStages(): Generator<DebugStage, VectorResult> {
  if (!mask || !flat) throw Error("AIマスクがありません。");
  const threshold = Number($<HTMLInputElement>("threshold").value),
    epsilon = Number($<HTMLInputElement>("epsilon").value);
  const foregroundCount = mask.probabilities.reduce((n,p)=>n+Number(p>=threshold),0);
  if (!foregroundCount || foregroundCount === mask.probabilities.length) throw Error("前景が空または全面です。閾値を変更するか自動調整を試してください。");
  const binaryStarted = performance.now(),
    binaryImage = maskDebugImage(mask, threshold),
    binaryElapsed = performance.now() - binaryStarted;
  yield {
    id: "binary",
    title: "実際の確率を閾値で2値化",
    image: binaryImage,
    elapsedMs: binaryElapsed,
    details: {
      threshold,
      native_mask_size_px: [mask.width, mask.height],
      note: "White = foreground; no photograph-edge or truth substitution.",
    },
  };
  const traceStarted = performance.now(),
    trace = traceMask(mask, board, threshold),
    traceElapsed = performance.now() - traceStarted;
  yield {
    id: "contours",
    title: "AIマスクから追跡した生の輪郭",
    image: geometryDebugImage(flat, board, trace.rawGeometry, false, trace),
    elapsedMs: traceElapsed,
    details: {
      contours: trace.contours.map((c) => ({
        hole: c.hole,
        vertices_mm: c.points,
      })),
      selected_outer_vertices: trace.rawGeometry.outer.length,
      selected_holes: trace.rawGeometry.holes.length,
      discarded_component_count: trace.discardedComponentCount,
      warnings: trace.warnings,
    },
  };
  const simplifyStarted = performance.now(),
    r = simplifyMaskTrace(trace, epsilon),
    simplifyElapsed = performance.now() - simplifyStarted;
  yield {
    id: "polygon",
    title: "簡略化したポリゴン・実寸",
    image: geometryDebugImage(flat, board, r.geometry, true),
    elapsedMs: simplifyElapsed,
    details: {
      mode: "B",
      epsilon_mm: epsilon,
      outer_vertices_mm: r.geometry.outer,
      holes_vertices_mm: r.geometry.holes,
      net_area_mm2: geometryArea(r.geometry),
      edges: [r.geometry.outer, ...r.geometry.holes].map((ring) =>
        edgeMeasurements(ring),
      ),
      warnings: r.warnings,
    },
  };
  return { r, rawGeometry: trace.rawGeometry, epsilon, threshold };
}
function commitVector(result: VectorResult) {
  journey.setGeometry(result.rawGeometry, result.r.geometry, journeyToken);
  geometries.B = result.r.geometry;
  warnings.B = result.r.warnings;
  provenance.B = {
    ...provenance.B,
    epsilon_mm: result.epsilon,
    mask_threshold: result.threshold,
  };
}
function revectorize() {
  resetTuning();
  if(provenance.B) delete provenance.B.automatic_adjustment;
  if (!mask) return;
  journey.clearAnalysis(journeyToken);
  journey.setMask(mask, Number($<HTMLInputElement>("threshold").value), journeyToken);
  debug.remove(["binary", "contours", "polygon"]);
  try {
    const stages = vectorStages();
    let next = stages.next();
    while (!next.done) {
      debug.record(next.value);
      next = stages.next();
    }
    commitVector(next.value);
    journey.setProcessing("実際のAIマスクから輪郭を再計算しました", "complete", journeyToken);
  } catch (e) {
    delete geometries.B;
    warnings.B = [String(e)];
    status(String(e), true);
    debug.fail("マスクから有効な輪郭を抽出できません。");
    journey.fail("有効な輪郭を抽出できません。閾値・εを確認してください。", journeyToken);
  }
  render();
}
async function runModeB(vectorize = true) {
  resetTuning();
  if (!flat) throw Error("平面補正が必要です。");
  if (journeyToken === undefined && source && journeyMarkerReport) {
    journeyToken = journey.begin(source, board);
    journey.setMarkers(journeyMarkerReport, journeyToken);
    journey.setRectified(flat, homographyDetails(markers, board), journeyToken);
  }
  debug.remove(["probability", "binary", "contours", "polygon"]);
  journey.clearAnalysis(journeyToken);
  const token = journeyToken;
  delete geometries.B;
  delete provenance.B;
  delete warnings.B;
  mask = undefined;
  maskUrl = "";
  render();
  try {
    mask = await segment(flat, processing, pipelineAbort?.signal);
    pipelineAbort?.signal.throwIfAborted();
    journey.setMask(mask, Number($<HTMLInputElement>("threshold").value), token);
    provenance.B = {
      method: "U2NetP-ONNX-WASM",
      model_sha256:
        "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
      native_mask_size_px: [320, 320],
      inference_elapsed_ms: mask.elapsedMs,
      stage_timings_ms: mask.timingsMs,
      scale_mm_per_px: board.width / board.pixelWidth,
    };
    maskUrl = maskDebugImage(mask);
    await debug.checkpoint(
      {
        id: "probability",
        title: "実ニューラル推論の確率画像",
        image: maskUrl,
        elapsedMs: mask.elapsedMs,
        details: {
          model: "U2NetP",
          model_sha256:
            "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
          native_mask_size_px: [mask.width, mask.height],
          timings_ms: mask.timingsMs ?? null,
          normalization:
            "first model output, min-max [0,1]; not calibrated probability",
          note: "White = predicted foreground. Missing holes remain missing.",
        },
      },
      pipelineAbort?.signal,
    );
    if (!vectorize) return;
    const stages = vectorStages();
    let next = stages.next();
    while (!next.done) {
      await debug.checkpoint(next.value, pipelineAbort?.signal);
      pipelineAbort?.signal.throwIfAborted();
      next = stages.next();
    }
    commitVector(next.value);
    active = "B";
    processing(
      `実際のU²-NetP推論が完了（${(mask.elapsedMs / 1000).toFixed(1)}秒）。穴と細部を写真に重ねて確認してください。`,
    );
  } catch (error) {
    if (
      pipelineAbort?.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      mask = undefined;
      maskUrl = "";
      delete geometries.B;
      delete provenance.B;
      delete warnings.B;
    }
    if (!pipelineAbort?.signal.aborted && mask && vectorize && $<HTMLInputElement>("autoRecover").checked) {
      await runAutomaticSearch("現在の閾値・εで輪郭を作れないため復旧候補を探索", false);
      return;
    }
    throw error;
  }
}

function resetTuning() {
  tuneEpoch++;
  tuneResult = undefined; tuneSelectedId = undefined; tuneReview = undefined; tuneImages.clear(); tuneOriginal=undefined;
  $("tuneBefore").classList.add("hidden");
  $<HTMLImageElement>("tuneBeforeImage").removeAttribute("src");
  $("tuneBeforeMetrics").textContent="";
  debug.remove(["tuning"]);
  $("tuneCandidates").replaceChildren();
  $("tuneStatus").textContent = "未実行。前景閾値 0.10〜0.90 / εは現在値以下を探索します。";
  $("tuneDetails").textContent = "未実行";
  $("reviewStatus").textContent = "LLM評価は未実行です。";
  $("reviewUsage").textContent = "API呼出し0回。各回の出力上限1,200トークン。料金上限の保証ではありません。";
  $<HTMLInputElement>("reviewConsent").checked = false;
}
function recordTuning() {
  const details = { app_build: APP_BUILD, local: tuneResult ? candidateSearchDiagnostics(tuneResult) : null, llm: tuneReview ?? {status:"not_executed"}, selected_candidate_id:tuneSelectedId??null };
  $("tuneDetails").textContent = JSON.stringify(details,null,2);
  debug.record({id:"tuning",title:"実マスクの有界探索・任意LLM評価",details});
}
function renderTuning() {
  const root=$("tuneCandidates");root.replaceChildren();
  if (!flat || !mask || !tuneResult) return;
  const list=[...tuneResult.candidates];
  const reviewed=list.find(c=>c.id===tuneReview?.chosen_candidate_id);
  if(reviewed){list.splice(list.indexOf(reviewed),1);list.unshift(reviewed);}
  const selected=list.find(c=>c.id===tuneSelectedId);
  if(selected) {list.splice(list.indexOf(selected),1);list.unshift(selected);}
  for(const candidate of list.slice(0,6)) {
    let image=tuneImages.get(candidate.id);
    if(!image) {image=candidateOverlay(flat,board,mask,candidate.geometry,candidate.threshold);tuneImages.set(candidate.id,image);}
    const card=document.createElement("article");card.className=`tune-card${candidate.id===tuneSelectedId?" selected":""}`;card.dataset.candidateId=candidate.id;
    const img=document.createElement("img");img.src=image;img.alt=`閾値${candidate.threshold.toFixed(3)}の実マスクと輪郭`;card.append(img);
    const body=document.createElement("div");body.className="tune-card-body";
    const title=document.createElement("strong");title.textContent=`閾値 ${candidate.threshold.toFixed(3)} / ε ${candidate.epsilon.toFixed(2)} mm`;body.append(title);
    if(candidate.id===tuneReview?.chosen_candidate_id){const label=document.createElement("p");label.textContent=tuneReview?.applied?"LLM評価の選択候補":"LLM評価の選択候補 · 未採用";body.append(label);}
    const metrics=document.createElement("p");metrics.textContent=`画像との一致は未確認 · ${candidate.grade==="usable"?"数値条件内":"要確認"}\n安定性 ${candidate.metrics.thresholdStability.toFixed(3)} · マスク保持 ${candidate.metrics.regionFidelityIoU.toFixed(3)}\n穴 ${candidate.metrics.simplifiedHoleCount} · 除外領域 ${(candidate.metrics.discardedAreaRatio*100).toFixed(1)}%`;body.append(metrics);
    if(!candidate.safeToAutoApply){const warning=document.createElement("p");warning.className="warn";warning.textContent="穴・領域の変動などがあり自動採用しません。写真と照合してから選んでください。";body.append(warning);}
    const button=document.createElement("button");button.dataset.applyCandidate=candidate.id;button.textContent=candidate.id===tuneSelectedId?"採用中":"この候補を採用";button.disabled=busy;button.onclick=()=>{if(!busy)applyTuningCandidate(candidate,"手動選択");};body.append(button);card.append(body);root.append(card);
  }
  recordTuning();
}
function applyTuningCandidate(candidate:Candidate, reason:string) {
  if(drawing || dragging || !mask || !flat || !tuneResult) throw Error("現在の画像に適用できる候補がありません。");
  const canonical=tuneResult.candidates.find(c=>c.id===candidate.id&&c.threshold===candidate.threshold&&c.epsilon===candidate.epsilon);
  if(!canonical || JSON.stringify(canonical.geometry)!==JSON.stringify(candidate.geometry))throw Error("候補が更新されています。現在の一覧から選び直してください。");
  candidate=canonical;
  $<HTMLInputElement>("threshold").value=String(candidate.threshold);
  $<HTMLInputElement>("epsilon").value=String(candidate.epsilon);
  if(Number($<HTMLInputElement>("threshold").value)!==candidate.threshold || Number($<HTMLInputElement>("epsilon").value)!==candidate.epsilon) throw Error("候補の設定を正確に反映できません。採用を停止しました。");
  $("thresholdValue").textContent=candidate.threshold.toFixed(3);
  $("epsilonValue").textContent=`${candidate.epsilon.toFixed(2)} mm`;
  journey.clearAnalysis(journeyToken);journey.setMask(mask,candidate.threshold,journeyToken);
  debug.remove(["binary","contours","polygon"]);
  const stages=vectorStages();let next=stages.next();
  while(!next.done){debug.record(next.value);next=stages.next();}
  commitVector(next.value);
  warnings.B=[...new Set([...(warnings.B??[]),"自動調整の指標は精度・写真との一致を保証しません。穴と細部を必ず確認してください。",...candidate.warnings])];
  tuneSelectedId=candidate.id;
  if(tuneReview) tuneReview={...tuneReview,applied:tuneReview.chosen_candidate_id===candidate.id,adoption:reason==="手動選択"?"manual":"automatic"};
  provenance.B={...provenance.B,automatic_adjustment:{reason,candidate_id:candidate.id,score:candidate.score,metrics:candidate.metrics,grade:candidate.grade,local_search:tuneResult?candidateSearchDiagnostics(tuneResult):null,llm:!tuneReview?{status:"not_executed"}:tuneReview.chosen_candidate_id===candidate.id?tuneReview:{status:"not_evaluated_for_this_candidate"}}};
  active="B";renderTuning();render();
  journey.setProcessing("実マスクの候補を採用しました。写真との一致は要確認です", "complete",journeyToken);
}
async function runAutomaticSearch(reason:string, obtainMask=true) {
  if(drawing||dragging)throw Error("編集中の図形を確定または中止してください。");
  if(!flat) throw Error("平面補正が必要です。");
  tuneRunActive=true;updateButtons();
  try {
    if(!mask) {if(!obtainMask)throw Error("AIマスクがありません。");await runModeB(false);}
    if(!mask || !flat) throw Error("AIマスクがありません。");
    const fixedMask=mask,fixedFlat=flat,fixedBoard=board,epoch=tuneEpoch;
    tuneReview=undefined;tuneImages.clear();
    if(geometries.B) {
      tuneOriginal={geometry:cloneGeometry(geometries.B),provenance:provenance.B?structuredClone(provenance.B):undefined,warnings:warnings.B?[...warnings.B]:undefined,threshold:Number(provenance.B?.mask_threshold??$<HTMLInputElement>("threshold").value),epsilon:Number(provenance.B?.epsilon_mm??$<HTMLInputElement>("epsilon").value)};
      $<HTMLImageElement>("tuneBeforeImage").src=candidateOverlay(fixedFlat,fixedBoard,fixedMask,tuneOriginal.geometry,tuneOriginal.threshold);
      $("tuneBeforeMetrics").textContent=`閾値${tuneOriginal.threshold.toFixed(3)} / ε${tuneOriginal.epsilon.toFixed(2)} mm · 面積${fmt(geometryArea(tuneOriginal.geometry))} mm² · 穴${tuneOriginal.geometry.holes.length}`;
      $("tuneBefore").classList.remove("hidden");
    }
    $("reviewStatus").textContent="LLM評価は未実行です。";
    $("tuneStatus").textContent=reason;
    const result=await searchMaskCandidates(fixedMask,fixedBoard,{currentThreshold:Number($<HTMLInputElement>("threshold").value),currentEpsilon:Number($<HTMLInputElement>("epsilon").value),signal:pipelineAbort?.signal,onProgress:p=>{
      $("tuneStatus").textContent=`${reason} · ${p.attempts}/${p.maxCandidates}設定を処理、${p.validCandidates}候補（${(p.elapsedMs/1000).toFixed(1)}秒）`;
    }});
    if(epoch!==tuneEpoch||mask!==fixedMask||flat!==fixedFlat||board!==fixedBoard) return;
    tuneResult=result;
    const best=result.candidates.find(c=>c.safeToAutoApply);
    if(result.stoppedReason==="cancelled"||pipelineAbort?.signal.aborted){
      $("tuneStatus").textContent="探索を中止しました。前の計測結果は変更せず、終了した候補を一覧に残しています。";
      renderTuning();return;
    }
    if(best){applyTuningCandidate(best,"端末内探索");$("tuneStatus").textContent=`${result.attempts.length}設定を比較し、輪郭を取得しました。画像との一致は未確認です（${(result.elapsedMs/1000).toFixed(1)}秒）。最適値や正解の保証はありません。${result.stoppedReason!=="completed"?"探索上限で終了しています。":""}`;}
    else {$("tuneStatus").textContent=result.candidates.length?"候補はありますが穴・領域などが不安定です。自動採用せず、前の計測結果を保持しました。写真と照合して選択してください。":"探索範囲内で有効候補がありません。前の計測結果を保持しました。撮影・AIマスクを確認してください。";renderTuning();}
    pipelineFinishMessage=best?"輪郭を取得しました · 写真との一致は未確認です":result.candidates.length?"探索終了 · 曖昧な候補は写真との照合・手動確認が必要です":"探索終了 · 範囲内に有効候補なし。撮影・AIマスクを確認してください";
    status(pipelineFinishMessage,!best);debug.progress(pipelineFinishMessage);
    recordTuning();
  } finally {tuneRunActive=false;updateButtons();}
}
function numericMetrics(candidate:Candidate):Record<string,number> {
  return Object.fromEntries(Object.entries(candidate.metrics).filter(([,value])=>typeof value==="number").slice(0,24)) as Record<string,number>;
}
type RenderedReviewCandidate=ReviewCandidate&{local:Candidate};
function toReviewCandidate(candidate:Candidate):RenderedReviewCandidate {
  const overlayDataUrl=tuneImages.get(candidate.id)??candidateOverlay(flat!,board,mask!,candidate.geometry,candidate.threshold);
  tuneImages.set(candidate.id,overlayDataUrl);
  return {id:candidate.id,threshold:candidate.threshold,epsilon:candidate.epsilon,metrics:numericMetrics(candidate),overlayDataUrl,safe:validateGeometry(candidate.geometry).valid,local:candidate};
}
function showReviewAttempts(attempts:ReviewAttempt[]) {
  const costs=attempts.reduce((sum,a)=>sum+(a.usage.costUsd??0),0),unknown=attempts.filter(a=>a.chargeStatus==="unknown").length;
  const tokens=attempts.reduce((sum,a)=>sum+(a.usage.totalTokens??0),0),tokenUnknown=attempts.some(a=>a.usage.totalTokens===null);
  $("reviewUsage").textContent=`API評価試行 ${attempts.length}回（画像送信 ${attempts.filter(a=>a.inferenceSent===true).length}回${attempts.some(a=>a.inferenceSent===null)?"＋不明分":""}） · 報告トークン ${tokens}${tokenUnknown?"＋不明分":""} · 報告料金 $${costs.toFixed(6)}${unknown?` ＋料金不明 ${unknown}回`:""}。送信済み料金は取消できない場合があります。`;
}
async function runAutomaticReview() {
  if(drawing||dragging)throw Error("編集中の図形を確定または中止してください。");
  if(!flat||!mask||!tuneResult||!$<HTMLInputElement>("reviewConsent").checked)throw Error("候補と画像送信の確認が必要です。");
  const selectedProvider=provider(), key=$<HTMLInputElement>("apiKey").value, keyError=validateProviderKey(selectedProvider,key);
  if(keyError)throw Error(keyError);
  const safe=tuneResult.candidates.find(c=>c.safeToAutoApply)??tuneResult.candidates[0];if(!safe)throw Error("幾何的に有効な候補がありません。");
  const maxCalls=Number($<HTMLSelectElement>("reviewMaxCalls").value);if(![1,2,3].includes(maxCalls))throw Error("評価上限は1〜3回です。");
  const fixedMask=mask,fixedFlat=flat,fixedBoard=board,epoch=tuneEpoch;
  activeRequest=new AbortController();tuneRunActive=true;updateButtons();
  const signal=AbortSignal.any([activeRequest.signal,pipelineAbort!.signal]);
  const candidates=tuneResult.candidates.slice(0,4).map(toReviewCandidate),attempts:ReviewAttempt[]=[];
  tuneReview=undefined;$("reviewStatus").textContent="選択済み接続先で評価を開始します…";showReviewAttempts([]);
  try {
    const result=await runReviewLoop({initialCandidates:candidates,localFallback:toReviewCandidate(safe),maxCalls:maxCalls as 1|2|3,signal,
      evaluate:(batch,attempt,callSignal)=>reviewCandidates({provider:selectedProvider,key,consent:true,photographDataUrl:reviewPhotograph(fixedFlat),candidates:batch,signal:callSignal,progress:message=>{$("reviewStatus").textContent=`${attempt}/${maxCalls}回 · ${message}`;}}),
      refine:async(review:CandidateReview,current,best)=>{
        signal.throwIfAborted();
        const center=best?.local??current[0].local, direction=review.adjustment.threshold_direction;
        if(direction==="none"&&review.adjustment.epsilon_direction==="none")return[];
        const thresholds=direction==="none"?[center.threshold]:[0.02,0.04,0.08,0.12].map(delta=>center.threshold+(direction==="higher"?delta:-delta)).filter(t=>t>=0.1&&t<=0.9);
        const refined=await searchMaskCandidates(fixedMask,fixedBoard,{currentThreshold:center.threshold,currentEpsilon:review.adjustment.epsilon_direction==="lower"?Math.max(0.5,center.epsilon/2):center.epsilon,candidateThresholds:thresholds,maxCandidates:80,signal,onProgress:p=>{$("reviewStatus").textContent=`LLMの方向提案から実マスクを再探索 · ${p.attempts}設定`;}});
        signal.throwIfAborted();
        if(epoch!==tuneEpoch||mask!==fixedMask||flat!==fixedFlat||board!==fixedBoard)throw new DOMException("画像が変更されました","AbortError");
        tuneResult=mergeSearchResults(tuneResult!,refined);
        const suggested=refined.candidates.filter(c=>(direction==="none"||direction==="higher"&&c.threshold>center.threshold||direction==="lower"&&c.threshold<center.threshold)&&(review.adjustment.epsilon_direction!=="lower"||c.epsilon<center.epsilon));
        renderTuning();return suggested.slice(0,4).map(toReviewCandidate);
      },onAttempt:attempt=>{attempts.push(attempt);showReviewAttempts(attempts);}});
    if(epoch!==tuneEpoch||mask!==fixedMask||flat!==fixedFlat||board!==fixedBoard)return;
    tuneReview={status:result.evaluated?"evaluated":"not_evaluated",reason:result.reason,provider:selectedProvider,model:PROVIDERS[selectedProvider].model,chosen_candidate_id:result.evaluated?result.candidate.id:null,evaluation:result.evaluation,attempts:result.attempts,reported_cost_usd:result.reportedCostUsd,unknown_cost_attempts:result.unknownCostAttempts};
    const canonical=tuneResult.candidates.find(c=>c.id===result.candidate.id);
    let applied=false;
    if(result.reason!=="cancelled"&&!signal.aborted&&result.evaluated&&canonical?.safeToAutoApply) {applyTuningCandidate(canonical,"LLM評価済み候補（誤判定あり）");applied=true;}
    tuneReview.applied=applied;
    const labels:Record<string,string>={accepted:"LLMが妥当と評価した候補で停止",plateau:"評価の改善が停滞したため停止","no-new-candidates":"新しい有効候補がなく停止","max-calls":"呼出し上限で停止",cancelled:"中止しました。前の計測結果を保持",failed:"API評価に失敗。機械候補を保持","model-stop":"LLMの停止判断で終了"};
    $("reviewStatus").textContent=`${labels[result.reason]}。${result.evaluated&&!applied?"計測結果は変更していません。曖昧な候補は写真を確認して「この候補を採用」を押してください。":""}${result.evaluated?"終了までの最良評価を保持しますが、写真との一致・寸法精度は保証しません。":"LLM評価は未完了です。未評価を成功扱いしません。"}`;
    pipelineFinishMessage=$("reviewStatus").textContent??"評価終了";status(pipelineFinishMessage);
    renderTuning();recordTuning();
  } finally {activeRequest=undefined;tuneRunActive=false;updateButtons();}
}
$("tuneRestore").onclick=()=>{
  if(busy||drawing||dragging||!tuneOriginal)return;
  const previous=tuneOriginal;
  geometries.B=cloneGeometry(previous.geometry);provenance.B=previous.provenance;warnings.B=previous.warnings;
  $<HTMLInputElement>("threshold").value=String(previous.threshold);$<HTMLInputElement>("epsilon").value=String(previous.epsilon);
  $("thresholdValue").textContent=previous.threshold.toFixed(3);$("epsilonValue").textContent=`${previous.epsilon.toFixed(2)} mm`;
  tuneSelectedId=undefined;active="B";
  if(tuneReview)tuneReview={...tuneReview,applied:false,adoption:"restored_previous_result"};
  if(mask){journey.clearAnalysis(journeyToken);journey.setMask(mask,previous.threshold,journeyToken);journey.setGeometry(traceMask(mask,board,previous.threshold).rawGeometry,previous.geometry,journeyToken);}
  debug.remove(["binary","contours","polygon"]);
  $("tuneStatus").textContent="調整前の結果に戻しました。探索候補は比較用に残っています。";renderTuning();render();
};
$("autoTune").onclick=()=>void guarded(()=>runAutomaticSearch("閾値・εの候補を探索"));
$("reviewRun").onclick=()=>void guarded(runAutomaticReview);
$("tuneStop").onclick=()=>{pipelineAbort?.abort();activeRequest?.abort();};
$<HTMLInputElement>("reviewConsent").onchange=()=>{activeRequest?.abort();updateButtons();};
$("reviewKeys").onclick=()=>{const section=$("provider").closest("details")!;section.open=true;section.scrollIntoView({block:"center",behavior:"instant"});};

function editCommit(g: Geometry, message = "編集を反映しました。") {
  journey.stopForEdit();
  const v = validateGeometry(g);
  if (!v.valid) {
    status(`変更を取り消しました: ${v.errors.join(" ")}`, true);
    return false;
  }
  if (
    allRings(g)
      .flat()
      .some(
        (p) => p.x < 0 || p.y < 0 || p.x > board.width || p.y > board.height,
      )
  ) {
    status("基準範囲外の頂点は確定できません。", true);
    return false;
  }
  if (geometries.C) undo.push(cloneGeometry(geometries.C));
  geometries.C = g;
  provenance.C = {
    ...provenance.C,
    method: "human-edited",
    edited_at: new Date().toISOString(),
  };
  status(message);
  render();
  return true;
}
// Keep the picker call synchronous with the user's button activation.
for (const [buttonId, inputId] of [
  ["upload", "file"],
  ["camera", "cameraFile"],
]) {
  const input = $<HTMLInputElement>(inputId);
  $(buttonId).onclick = () => {
    if (!busy) input.click();
  };
  input.onchange = () => handlePhotoSelection(input);
}
function handlePhotoSelection(input: HTMLInputElement) {
  const f = input.files?.[0];
  // Allow retrying the same photo after a decode error or cancelled processing.
  input.value = "";
  if (!f || busy) return;
  void guarded(async () => {
    if (f.size > 30 * 1024 * 1024)
      throw Error("30 MB以下の画像を選んでください。");
    invalidateSource();
    sampleId = "";
    truth = undefined;
    sourceName = f.name;
    document
      .querySelectorAll(".sample")
      .forEach((b) => b.classList.remove("active"));
    const url = URL.createObjectURL(f);
    try {
      const loaded = await loadImage(url).catch(() => {
        pipelineAbort?.signal.throwIfAborted();
        const heic =
          /\.hei[cf]$/i.test(f.name) || /^image\/hei[cf](?:-sequence)?$/i.test(f.type);
        throw Error(
          heic
            ? "このHEIC/HEIF画像を読み込めませんでした。この端末・ブラウザで未対応か、ファイルが壊れている可能性があります。JPEGまたはPNGに変換した画像を選んでください。"
            : "画像を読み込めませんでした。JPEGまたはPNGなど、このブラウザで表示できる画像を選んでください。",
        );
      });
      pipelineAbort?.signal.throwIfAborted();
      // The browser's image decoder applies EXIF orientation. Do not rotate again.
      source = imageCanvas(loaded);
    } finally {
      URL.revokeObjectURL(url);
    }
    photoUrl = source.toDataURL("image/jpeg", 0.95);
    $("sourceLabel").textContent = f.name;
    pipelineAbort?.signal.throwIfAborted();
    await calibrate();
  });
}
document.querySelectorAll<HTMLButtonElement>("[data-sample]").forEach(
  (b) =>
    (b.onclick = () => {
      void loadSample(b.dataset.sample!);
    }),
);
$<HTMLSelectElement>("preset").onchange = () => {
  if (busy) return;
  journey.reset();
  journeyToken = undefined;
  const p = $<HTMLSelectElement>("preset").value;
  $("custom").classList.toggle("hidden", p !== "custom");
  if (p === "custom") {
    truth = undefined;
    flat = undefined;
    flatUrl = "";
    gridUrl = "";
    debug.reset();
    resetResults();
    status("カスタム寸法を入力して、平面補正を実行してください。");
  } else {
    board = { ...PRESETS[p] };
    truth = undefined;
    void guarded(calibrate);
  }
};
for (const id of ["width", "height"])
  $<HTMLInputElement>(id).onchange = () => {
    if (busy) return;
    journey.reset();
    journeyToken = undefined;
    flat = undefined;
    flatUrl = "";
    gridUrl = "";
    truth = undefined;
    debug.reset();
    resetResults();
    try {
      board = customBoard(
        Number($<HTMLInputElement>("width").value),
        Number($<HTMLInputElement>("height").value),
      );
      flat = undefined;
      flatUrl = "";
      truth = undefined;
      resetResults();
      status("基準寸法を変更しました。平面補正を再実行してください。");
    } catch (e) {
      status(String(e), true);
    }
  };
$("rectify").onclick = () =>
  void guarded(async () => {
    if ($<HTMLSelectElement>("preset").value === "custom")
      board = customBoard(
        Number($<HTMLInputElement>("width").value),
        Number($<HTMLInputElement>("height").value),
      );
    await calibrate();
  });
$("runB").onclick = () => void guarded(async () => { focusJourney(); await runModeB(); });
for (const id of ["epsilon", "threshold"])
  $<HTMLInputElement>(id).oninput = () => {
    $("epsilonValue").textContent =
      `${Number($<HTMLInputElement>("epsilon").value).toFixed(1)} mm`;
    $("thresholdValue").textContent = Number(
      $<HTMLInputElement>("threshold").value,
    ).toFixed(2);
    if (busy) return;
    const previous = geometries.B ? { geometry: geometries.B, provenance: provenance.B ? structuredClone(provenance.B) : undefined, warnings: warnings.B ? [...warnings.B] : undefined } : undefined;
    revectorize();
    if (!geometries.B && mask && $<HTMLInputElement>("autoRecover").checked) {
      if (previous) { geometries.B = previous.geometry; provenance.B = previous.provenance; warnings.B = previous.warnings; }
      void guarded(async()=>runAutomaticSearch("手動設定のエラーから復旧候補を探索",false));
    }
  };
$<HTMLInputElement>("apiKey").oninput = () => {
  activeRequest?.abort();
  $<HTMLInputElement>("reviewConsent").checked=false;
  $<HTMLInputElement>("consent").checked = false;
  const result = keyStore.save(provider(), $<HTMLInputElement>("apiKey").value);
  if (result.status === "clear-failed") $<HTMLInputElement>("apiKey").value = "";
  showKeyStorageStatus(result.status);
  updateProviderUI();
  updateButtons();
};
$<HTMLInputElement>("consent").oninput = () => {
  activeRequest?.abort();
  updateButtons();
};
$("clearKey").onclick = () => {
  activeRequest?.abort();
  $<HTMLInputElement>("reviewConsent").checked = false;
  $<HTMLInputElement>("apiKey").value = "";
  $<HTMLInputElement>("consent").checked = false;
  showKeyStorageStatus(keyStore.clear(provider()).status);
  updateProviderUI();
  updateButtons();
  status("このタブのAPIキーを消去しました。保存領域の削除結果はキー欄に表示しています。実行中なら通信を中止しますが、送信済みデータや発生済み料金は取り消せません。");
};
$<HTMLSelectElement>("provider").onchange = () => {
  activeRequest?.abort();
  restoreProviderKey();
  status(`接続先を${PROVIDERS[provider()].name}に変更しました。この接続先のキーだけを使用します。送信前に確認してください。`);
};
window.addEventListener("storage", (event) => {
  try { if (event.storageArea !== window.localStorage) return; } catch { return; }
  if (event.key !== null && event.key !== providerStorageKey(provider())) return;
  activeRequest?.abort();
  restoreProviderKey();
});
$("runA").onclick = () =>
  void guarded(async () => {
    if (!flat || !$<HTMLInputElement>("consent").checked)
      throw Error("写真送信とAPI利用料の確認が必要です。");
    revealEditor("Mode Aは外部APIの実応答を計測キャンバスに表示します。");
    const selectedProvider = provider(),
      key = $<HTMLInputElement>("apiKey").value,
      keyError = validateProviderKey(selectedProvider, key);
    if (keyError) throw Error(keyError);
    delete geometries.A;
    delete provenance.A;
    delete warnings.A;
    active = "A";
    debug.remove(["api", "polygon"]);
    render();
    activeRequest = new AbortController();
    const signal = AbortSignal.any([
      activeRequest.signal,
      pipelineAbort!.signal,
    ]);
    try {
      const grid = makeGridStage(flat);
      gridUrl = grid.stage.image!;
      await debug.checkpoint(grid.stage, signal);
      const started = performance.now(),
        r = await inferLunaProvider(
          selectedProvider,
          key,
          grid.image,
          board,
          processing,
          signal,
        ),
        elapsedMs = performance.now() - started;
      await debug.checkpoint(
        {
          id: "api",
          title: "実際のGPT-6 Luna応答",
          elapsedMs,
          details: {
            provider: r.provider,
            model: r.model,
            endpoint: PROVIDERS[r.provider].endpoint,
            request_id: r.requestId,
            geometry_validated: true,
          },
        },
        signal,
      );
      await debug.checkpoint(
        {
          id: "polygon",
          title: "Mode Aの実応答・実寸",
          image: geometryDebugImage(flat, board, r.geometry, true),
          details: {
            mode: "A",
            provider: r.provider,
            outer_vertices_mm: r.geometry.outer,
            holes_vertices_mm: r.geometry.holes,
            net_area_mm2: geometryArea(r.geometry),
            edges: [r.geometry.outer, ...r.geometry.holes].map((ring) =>
              edgeMeasurements(ring),
            ),
          },
        },
        signal,
      );
      signal.throwIfAborted();
      geometries.A = r.geometry;
      provenance.A = {
        method:
          r.provider === "openrouter"
            ? "OpenRouter-Chat-Completions-API"
            : "OpenAI-Responses-API",
        provider: r.provider,
        model: r.model,
        request_id: r.requestId,
        grid_step_mm: Number($<HTMLSelectElement>("gridstep").value),
        scale_mm_per_px: board.width / board.pixelWidth,
      };
      warnings.A = ["LLM座標は視覚的な推定です。製造用の精度を保証しません。"];
      active = "A";
      processing(
        "GPT-6 Lunaの実際の応答を表示しています。頂点・穴・寸法を確認してください。",
      );
    } finally {
      activeRequest = undefined;
    }
  });
$<HTMLSelectElement>("gridstep").onchange = () => {
  if (flat) {
    const grid = makeGridStage(flat);
    gridUrl = grid.stage.image!;
    debug.record(grid.stage);
  }
  renderCanvas();
};
for (const id of ["showA", "showB", "showC", "view"])
  $(id).onchange = renderCanvas;
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(
  (b) =>
    (b.onclick = () => {
      if (dragging) {
        geometries.C = dragging.before;
        dragging = undefined;
      }
      revealEditor("選択したモードを計測キャンバスで比較します。");
      active = b.dataset.mode as Mode;
      selected = undefined;
      drawing = undefined;
      render();
    }),
);
$("editC").onclick = () => {
  revealEditor();
  const g = geometries[active];
  if (!g) return;
  const from = active;
  geometries.C = cloneGeometry(g);
  provenance.C = {
    ...provenance[from],
    method: "human-edited",
    source_mode: from,
  };
  warnings.C = ["手動編集した図形です。正確な寸法は実物で確認してください。"];
  undo = [];
  active = "C";
  $<HTMLSelectElement>("view").value = "rectified";
  status("Cモード: ピンを動かすか、辺をタップして頂点を追加できます。");
  render();
};
$("undo").onclick = () => {
  const g = undo.pop();
  if (g) {
    geometries.C = g;
    selected = undefined;
    render();
    status("ひとつ前の図形に戻しました。");
  }
};
function deleteSelected() {
  if (!selected || !geometries.C || active !== "C") return;
  const g = cloneGeometry(geometries.C),
    r = allRings(g)[selected.ring];
  if (r.length <= 3) {
    status("輪郭には最低3頂点が必要です。", true);
    return;
  }
  r.splice(selected.index, 1);
  if (editCommit(g, "頂点を削除しました。")) selected = undefined;
  render();
}
$("delete").onclick = deleteSelected;
$("snap").onclick = () => {
  if (geometries.C)
    editCommit(
      nearAxisSnap(geometries.C, 5),
      "±5°以内の辺を水平・垂直に近づけました。輪郭と寸法を確認してください。",
    );
};
$("cancelDraw").onclick = () => {
  drawing = undefined;
  status("描画を中止しました。");
  render();
};
$("drawOuter").onclick = () => {
  revealEditor();
  if (!flat) return;
  active = "C";
  drawing = { kind: "outer", points: [] };
  selected = undefined;
  $<HTMLSelectElement>("view").value = "rectified";
  status(
    "外周の角を順にタップし、「図形を確定」を押してください。手描き結果として記録します。",
  );
  render();
};
$("drawHole").onclick = () => {
  revealEditor();
  drawing = { kind: "hole", points: [] };
  selected = undefined;
  status("穴の周囲を順にタップし、「図形を確定」を押してください。");
  render();
};
$("finishDraw").onclick = () => {
  if (!drawing) return;
  const g =
    drawing.kind === "outer"
      ? { outer: drawing.points, holes: [] }
      : geometries.C
        ? {
            outer: geometries.C.outer,
            holes: [...geometries.C.holes, drawing.points],
          }
        : undefined;
  if (g && editCommit(g, "手描きの輪郭を確定しました。")) {
    drawing = undefined;
    warnings.C = ["ユーザーが描いた図形です。AI推論結果ではありません。"];
    render();
  }
};
function eventPoint(e: PointerEvent) {
  const matrix = editor.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
    matrix.inverse(),
  );
  return {
    x: Math.max(0, Math.min(board.width, p.x)),
    y: Math.max(0, Math.min(board.height, p.y)),
  };
}
editor.addEventListener("pointerdown", (e: PointerEvent) => {
  if (busy || $<HTMLSelectElement>("view").value === "photo") return;
  const t = e.target as SVGElement;
  if (drawing) {
    drawing.points.push(eventPoint(e));
    renderCanvas();
    return;
  }
  if (active !== "C" || !geometries.C) return;
  const pin = t.getAttribute("data-pin");
  if (pin) {
    const [ring, index] = pin.split(",").map(Number);
    selected = { ring, index };
    dragging = {
      ring,
      index,
      before: cloneGeometry(geometries.C),
      moved: false,
    };
    editor.setPointerCapture(e.pointerId);
    e.preventDefault();
    render();
  } else if (t.getAttribute("data-edge")) {
    const [ri, i] = t.getAttribute("data-edge")!.split(",").map(Number);
    const g = cloneGeometry(geometries.C);
    allRings(g)[ri].splice(i + 1, 0, eventPoint(e));
    if (editCommit(g, "頂点を追加しました。")) {
      selected = { ring: ri, index: i + 1 };
      render();
    }
  }
});
editor.addEventListener("pointermove", (e: PointerEvent) => {
  if (!dragging || !geometries.C) return;
  dragging.moved = true;
  allRings(geometries.C)[dragging.ring][dragging.index] = eventPoint(e);
  render();
});
function finishDrag() {
  if (!dragging || !geometries.C) return;
  const d = dragging;
  dragging = undefined;
  if (d.moved) {
    const proposed = cloneGeometry(geometries.C);
    geometries.C = d.before;
    editCommit(proposed);
  }
  render();
}
editor.addEventListener("pointerup", finishDrag);
editor.addEventListener("pointercancel", () => {
  if (dragging) {
    geometries.C = dragging.before;
    dragging = undefined;
    render();
  }
});
editor.addEventListener("dblclick", (e) => {
  const p = (e.target as SVGElement).getAttribute("data-pin");
  if (p) {
    const [ring, index] = p.split(",").map(Number);
    selected = { ring, index };
    deleteSelected();
  }
});
function download(content: string, type: string, ext: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `scrap-${active.toLowerCase()}-${Date.now()}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
for (const [id, type, ext, fn] of [
  ["exportSvg", "image/svg+xml", "svg", createSvg],
  ["exportDxf", "application/dxf", "dxf", createDxf],
  ["exportJson", "application/json", "json", createJson],
] as const)
  $(id).onclick = () => {
    const g = geometries[active];
    if (!g) return;
    try {
      download(
        fn(g, board, board.preset, {
          ...provenance[active],
          app_build: APP_BUILD,
          scale_mm_per_px: board.width / board.pixelWidth,
          source_image: sampleId || "user-upload",
          scale_y_mm_per_px: board.height / board.pixelHeight,
        }),
        type,
        ext,
      );
      status(`${ext.toUpperCase()}を実寸mmで書き出しました。`);
    } catch (e) {
      status(String(e), true);
    }
  };
$("print").onclick = () => {
  const win = window.open(
    `${base}print/a4-marker-sheet.svg`,
    "_blank",
    "noopener",
  );
  if (!win)
    status(
      "ポップアップを許可するか、SVGをダウンロードしてA4横・100%で印刷してください。",
    );
  else
    status(
      "開いた台紙をA4横・100%（実際のサイズ）で印刷し、100 mm目盛りを実測してください。",
    );
};
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawing) {
    drawing = undefined;
    render();
    status("描画を中止しました。");
  }
});
window.addEventListener("pagehide", () => {
  activeRequest?.abort();
  pipelineAbort?.abort();
  journey.pause();
  $<HTMLInputElement>("apiKey").value = "";
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) restoreProviderKey();
});
restoreProviderKey();
render();
void loadSample("l-shape");
