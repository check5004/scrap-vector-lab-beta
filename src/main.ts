import { openCurveEditor } from './curve-editor';
import "./style.css";
import "./auto-tune.css";
import "./unified.css";
import { createAppShell } from "./app-shell";
import { APP_BUILD, APP_VERSION } from "./build-info";
import { tuningPanelHtml, candidateOverlay, reviewPhotograph } from "./tuning-ui";
import { mergeSearchResults } from "./tuning-state";
import { searchMaskCandidates, candidateSearchDiagnostics, type Candidate, type SearchResult } from "./auto-tune";
import { reviewCandidates, runReviewLoop, type ReviewCandidate, type ReviewAttempt, type CandidateReview } from "./candidate-review";
import { MeasurementJourney } from "./journey";
import { createKnownEdgeCalibration, transformMeasurementGeometry, calibrationContextMatches, measurementGeometrySignature, type KnownEdgeCalibration } from "./measurement-calibration";
import {
  type Geometry,
  type Point,
  buildMeasurement,
  createSvg,
  createDxf,
  createJson,
  svgExportBounds,
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
const html = createAppShell(base, APP_VERSION, APP_BUILD, tuningPanelHtml);
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
const calibrations: Partial<Record<Mode,KnownEdgeCalibration>> = {};
let failureNeedsKey = false;
let calibrationUiSignature = "";
let sourceEpoch = 0;
let unifiedRunActive = false;
let lastAnalysis: AnalysisSnapshot | undefined;
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
  runAll: () => void analyzeSelected(),
  onEdit: () => revealEditor(),
  onCancel: () => { pipelineAbort?.abort(); activeRequest?.abort(); },
});
function focusJourney() {
  $("editorSurface").classList.add("hidden");
  $("toggleEditor").setAttribute("aria-expanded", "false");
  $("toggleEditor").textContent = "計測キャンバスを開く";
  document.querySelector<HTMLElement>(".analysis-start")!.scrollIntoView({ behavior: "instant", block: "start" });
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
    showMethodResult(selectedMethod());
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
type RunAuthorization = { method: "A" | "B"; provider: Provider; key: string; review: boolean; maxCalls: number; epoch: number };
type AnalysisSnapshot = {
  epoch: number; active: Mode; geometries: Partial<Record<Mode,Geometry>>;
  provenance: Partial<Record<Mode,Record<string,unknown>>>; warnings: Partial<Record<Mode,string[]>>;
  mask?: MaskResult; maskUrl: string; threshold: number; epsilon: number;
  calibrations: Partial<Record<Mode,KnownEdgeCalibration>>;
};
function selectedMethod(): "A" | "B" {
  return $<HTMLInputElement>("methodA").checked ? "A" : "B";
}
function updateAnalysisDisclosure() {
  const method = selectedMethod(), external = method === "A" || $<HTMLInputElement>("autoReview").checked;
  const config = PROVIDERS[provider()];
  $("analysisDisclosure").textContent = !external
    ? "この端末で画像を解析します。外部への画像送信・API料金はありません。基準平面への補正から輪郭・寸法まで続けて実行します。"
    : method === "A"
      ? `「解析する」で、補正画像・方眼・基準寸法を${config.name}${provider()==="openrouter"?"とその推論提供先":""}へ送信します。有料のGPT-6 Luna推論を1回実行します（出力上限5,000トークン、金額上限ではありません）。`
      : `「解析する」で、端末内解析の後、補正画像と候補画像を${config.name}${provider()==="openrouter"?"とその推論提供先":""}へ送信して有料評価します。最大${$<HTMLSelectElement>("reviewMaxCalls").value}回、各1,200出力トークン。料金上限の保証ではありません。`;
  const validKey = !validateProviderKey(provider(), $<HTMLInputElement>("apiKey").value);
  $("analysisKeyStatus").textContent = external ? validKey ? `${config.name}のキー設定済み。送信・料金説明を確認して開始してください。` : `${config.name}のAPIキーを設定してください。写真と選択方式はそのまま保持します。` : "B · 実際のU²-NetPモデルを使用。穴・側面・影の判別には限界があります。";
  $("configureKey").hidden = !external;
  $<HTMLInputElement>("autoReview").disabled = busy || method === "A";
  document.querySelectorAll<HTMLElement>(".method-card").forEach(el=>el.classList.toggle("selected",!!el.querySelector<HTMLInputElement>("input")?.checked));
}
function openKeySettings() {
  $<HTMLDetailsElement>("apiSettings").open = true;
  $("apiSettings").scrollIntoView({block:"nearest",behavior:"instant"});
}
function showPreparedSource() {
  if (!source) return;
  active=selectedMethod();
  const canvas = $<HTMLCanvasElement>("sourcePreview"), scale = Math.min(1, 540 / source.width);
  canvas.width = Math.round(source.width*scale); canvas.height = Math.round(source.height*scale);
  canvas.getContext("2d")!.drawImage(source,0,0,canvas.width,canvas.height);
  $("inputSummary").textContent = `${sampleId ? "サンプル" : "選択した写真"} · ${source.width} × ${source.height} px`;
  journeyToken = journey.begin(source, board, selectedMethod());
  journey.pause();
  pipelineFinishMessage = "写真を読み込みました。方式を選んで「解析する」を押してください。";
  status(pipelineFinishMessage);
  journey.setProcessing(pipelineFinishMessage,"idle",journeyToken);
}
function invalidateCalibration() {
  sourceEpoch++; lastAnalysis=undefined;
  flat=undefined;flatUrl="";gridUrl="";markers=[];journeyMarkerReport=undefined;
  debug.reset();resetResults();showPreparedSource();
}
function prepareJourney(method: "A"|"B") {
  if (!source) return;
  journeyToken=journey.begin(source,board,method);
  if (journeyMarkerReport) journey.setMarkers(journeyMarkerReport,journeyToken);
  if (flat && markers.length===4) journey.setRectified(flat,homographyDetails(markers,board),journeyToken);
}
function ensureAnalysisMethod(method:"A"|"B") {
  const needsScene=active!==method||journey.selectedMethod!==method||journeyToken===undefined;
  if(dragging){geometries.C=dragging.before;dragging=undefined;}
  drawing=undefined;selected=undefined;active=method;
  $<HTMLInputElement>("methodA").checked=method==="A";$<HTMLInputElement>("methodB").checked=method==="B";
  if(needsScene){prepareJourney(method);if(method==="B"&&mask)journey.setMask(mask,Number($<HTMLInputElement>("threshold").value),journeyToken);}
  $("analysisSummary").dataset.method=method;
}
function showMethodResult(method:"A"|"B") {
  if(dragging){geometries.C=dragging.before;dragging=undefined;}
  drawing=undefined;selected=undefined;active=method;
  $<HTMLInputElement>("methodA").checked=method==="A";$<HTMLInputElement>("methodB").checked=method==="B";
  prepareJourney(method);
  const geometry=geometries[method];
  if(geometry && flat) {
    if(method==="B" && mask){const t=Number(provenance.B?.mask_threshold??0.5);journey.setMask(mask,t,journeyToken);journey.setGeometry(traceMask(mask,board,t).rawGeometry,geometry,journeyToken);}
    else if(method==="A")journey.setGeometry(geometry,journeyToken);
    journey.skip();
    status(`${method==="A"?"クラウドAI（A）":"この端末のAI（B）"}の取得済み結果を表示しています。`);
    journey.setProcessing("取得済みの結果 · 新しいAPI送信はありません","complete",journeyToken);
  } else {
    journey.skip();
    status(`${method==="A"?"クラウドAI（A）":"この端末のAI（B）"}は未解析です。「解析する」で開始します。`);
    journey.setProcessing("選択方式の解析待ち","idle",journeyToken);
  }
  $("analysisSummary").dataset.state=geometry?"complete":"idle";
  $("analysisSummary").dataset.method=method;
  syncCalibrationDiagnostic();
  render();
}
function captureAnalysis(): AnalysisSnapshot | undefined {
  if(!geometries[active]||!validateGeometry(geometries[active]!).valid)return;
  return {epoch:sourceEpoch,active,geometries:structuredClone(geometries),provenance:structuredClone(provenance),warnings:structuredClone(warnings),calibrations:structuredClone(calibrations),mask,maskUrl,threshold:Number($<HTMLInputElement>("threshold").value),epsilon:Number($<HTMLInputElement>("epsilon").value)};
}
function restoreAnalysis(snapshot:AnalysisSnapshot, message:string, preserveReviewRecord=true) {
  if(snapshot.epoch!==sourceEpoch)return;
  const currentReview=preserveReviewRecord&&active==="B"&&tuneReview?structuredClone(tuneReview):undefined;
  for(const m of ["A","B","C"] as Mode[]){delete geometries[m];delete provenance[m];delete warnings[m];delete calibrations[m];}
  Object.assign(geometries,structuredClone(snapshot.geometries));Object.assign(provenance,structuredClone(snapshot.provenance));Object.assign(warnings,structuredClone(snapshot.warnings));Object.assign(calibrations,structuredClone(snapshot.calibrations));
  mask=snapshot.mask;maskUrl=snapshot.maskUrl;
  $<HTMLInputElement>("threshold").value=String(snapshot.threshold);$<HTMLInputElement>("epsilon").value=String(snapshot.epsilon);
  $("thresholdValue").textContent=snapshot.threshold.toFixed(3);$("epsilonValue").textContent=`${snapshot.epsilon.toFixed(2)} mm`;
  active=snapshot.active;
  resetTuning();
  if(currentReview&&Array.isArray(currentReview.attempts)&&currentReview.attempts.length){
    tuneReview={...currentReview,applied:false,restored_previous_result:true};
    showReviewAttempts(currentReview.attempts as ReviewAttempt[]);
    $("reviewStatus").textContent="今回の評価記録・料金情報を保持しています。表示中の寸法は前回の結果に戻しました。";
    recordTuning();
  }
  if(active!=="C")showMethodResult(active);else{prepareJourney(selectedMethod());journey.stopForEdit();render();}
  status(message);
}
async function analyzeSelected() {
  if(busy||!source||drawing||dragging)return;
  const method=selectedMethod(), review=method==="B"&&$<HTMLInputElement>("autoReview").checked;
  const selectedProvider=provider(), needsExternal=method==="A"||review;
  // The single explicit start authorizes only the recipient, images and bounded work disclosed beside it.
  const key=needsExternal?$<HTMLInputElement>("apiKey").value:"";
  const keyError=needsExternal?validateProviderKey(selectedProvider,key):undefined;
  if(keyError){failureNeedsKey=true;$("analysisSummary").dataset.state="error";$("analysisFailure").hidden=false;$("analysisFailureMessage").textContent=keyError;status(keyError,true);openKeySettings();return;}
  const maxCalls=Number($<HTMLSelectElement>("reviewMaxCalls").value);
  if(review&&![1,2,3].includes(maxCalls)){status("LLM評価回数は1〜3回を選んでください。",true);return;}
  const authorization:RunAuthorization={method,provider:selectedProvider,key,review,maxCalls,epoch:sourceEpoch};
  const previous=captureAnalysis(); if(previous)lastAnalysis=previous;
  unifiedRunActive=true;failureNeedsKey=false;$("analysisFailure").hidden=true;
  $<HTMLInputElement>("debugStep").checked=false;
  $<HTMLDetailsElement>("apiSettings").open=false;
  active=method;
  try {
    await guarded(async()=>{
      readCustomBoard();
      if(!flat)await calibrate(method);
      else {
        prepareJourney(method);
        processing("同じ写真・基準寸法の検出と補正結果を再利用しています…");
        debug.remove(["api","probability","binary","contours","polygon","tuning"]);
      }
      pipelineAbort!.signal.throwIfAborted();
      if(authorization.epoch!==sourceEpoch)throw new DOMException("入力が変更されました","AbortError");
      if(method==="A")await runModeA(authorization);
      else {
        await runModeB();
        pipelineAbort!.signal.throwIfAborted();
        if(mask&&!tuneResult)await runAutomaticSearch("輪郭を保つ閾値・εを端末内で比較中",false);
        pipelineAbort!.signal.throwIfAborted();
        if(review&&tuneResult?.candidates.length)await runAutomaticReview(authorization);
        else if(review)$("reviewStatus").textContent="有効候補がないためLLMには送信していません。";
      }
      if(!geometries[method]) {
        $("analysisFailure").hidden=false;
        $("analysisFailureMessage").textContent="有効な輪郭を取得できませんでした。写真を変更するか、詳細で候補・設定を確認してください。";
        $<HTMLDetailsElement>("analysisSettings").open=true;
      }
      pipelineFinishMessage ??= `${method==="A"?"クラウドAI（A）":"この端末のAI（B）"}の解析が完了しました。上面の縁・穴・寸法を確認してください。`;
      status(pipelineFinishMessage);
    }, previous);
  } finally {unifiedRunActive=false;updateButtons();}
}
$("analyze").onclick=()=>void analyzeSelected();
$("retryAnalysis").onclick=()=>void analyzeSelected();
$("configureKey").onclick=openKeySettings;
$("closeKeySettings").onclick=()=>{$<HTMLDetailsElement>("apiSettings").open=false;$("analyze").focus();};
$("analysisCancel").onclick=()=>{pipelineAbort?.abort();activeRequest?.abort();};
$("failureSettings").onclick=()=>{if(failureNeedsKey){openKeySettings();return;}$<HTMLDetailsElement>("analysisSettings").open=true;$("analysisSettings").scrollIntoView({block:"nearest",behavior:"instant"});};
$("restoreAnalysis").onclick=()=>{if(!busy&&lastAnalysis)restoreAnalysis(lastAnalysis,"前回の解析結果に戻しました。新しい画像送信はありません。");};
for(const id of ["methodA","methodB"])$(id).onchange=()=>{if(!busy)showMethodResult(selectedMethod());};
$("autoReview").onchange=()=>{updateAnalysisDisclosure();};
$("reviewMaxCalls").onchange=()=>{updateAnalysisDisclosure();};

function showKeyStorageStatus(result: KeyStorageStatus) {
  const messages: Record<KeyStorageStatus, string> = {
    loaded: "この接続先の保存キーを復元しました。画像送信は「解析する」を押した時だけ行います。",
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
  $("exportStatus").textContent = "";
  $("analysisSummary").textContent = s;
  $("analysisProgress").textContent = s;
  $("status").textContent = s;
  $("status").classList.toggle("error", error);
}
function setBusy(v: boolean) {
  busy = v;
  if(v){$("analysisSummary").dataset.state="running";$("analysisSummary").dataset.method=selectedMethod();}
  journey.setBusy(v);
  $("progress").classList.toggle("hidden", !v);
  updateButtons();
  document.querySelectorAll<HTMLInputElement>('[name="analysisMethod"]').forEach(e => e.disabled = v);
  $<HTMLInputElement>("autoReview").disabled=v||selectedMethod()==="A";
  $("analysisCancel").hidden = !v;
  $("analysisProgress").hidden = !v;
  if(v&&unifiedRunActive)focusJourney();
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
  $<HTMLButtonElement>("analyze").disabled = busy || !source || !!drawing || !!dragging;
  $("analyze").textContent = busy ? "解析中…" : "解析する";
  $<HTMLButtonElement>("retryAnalysis").disabled = busy || !source;
  $<HTMLButtonElement>("restoreAnalysis").disabled = busy || !lastAnalysis || lastAnalysis.epoch !== sourceEpoch;
  $("restoreAnalysis").hidden = !lastAnalysis;
  updateAnalysisDisclosure();
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
    delete calibrations[m];
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
function currentCalibration(mode:Mode): KnownEdgeCalibration | undefined {
  const c=calibrations[mode],g=geometries[mode];
  if(!c)return;
  if(!g||!validateGeometry(g).valid||!calibrationContextMatches(c,{sourceEpoch,mode})||c.geometrySignature!==measurementGeometrySignature(g)) {
    if(!dragging){delete calibrations[mode];debug.remove(["calibration"]);}
    return;
  }
  return c;
}
function syncCalibrationDiagnostic() {
  const c=currentCalibration(active);
  debug.remove(["calibration"]);
  if(c)debug.record({id:"calibration",title:"既知の上面辺による計測値補正",details:{...c.provenance,photo_overlay_unchanged:true,physical_accuracy_tested:false}});
}
function measurementGeometry(mode:Mode):Geometry|undefined {
  const g=geometries[mode];
  return g?transformMeasurementGeometry(g,currentCalibration(mode),{sourceEpoch,mode}):undefined;
}
function renderCalibration() {
  const g=geometries[active],valid=!!g&&validateGeometry(g).valid,c=currentCalibration(active);
  const select=$<HTMLSelectElement>("calibrationEdge");
  let previous=select.value;
  const uiSignature=valid?`${sourceEpoch}:${active}:${measurementGeometrySignature(g)}`:`${sourceEpoch}:${active}:none`;
  if(uiSignature!==calibrationUiSignature && !dragging){
    calibrationUiSignature=uiSignature;
    $<HTMLInputElement>("calibrationAssumptions").checked=!!c;
    $<HTMLInputElement>("calibrationLength").value=c?String(c.knownLengthMm):"";
    previous=c?String(c.edgeIndex):"0";
  }
  select.innerHTML=valid?g.outer.map((p,i)=>`<option value="${i}">E${i+1} · 補正前 ${fmt(Math.hypot(p.x-g.outer[(i+1)%g.outer.length].x,p.y-g.outer[(i+1)%g.outer.length].y),2)} mm</option>`).join(""):'<option value="">解析後に辺を選択</option>';
  if(Array.from(select.options).some(o=>o.value===previous))select.value=previous;
  const locked=busy||!!drawing||!!dragging||!valid;
  for(const id of ["calibrationEdge","calibrationLength","calibrationAssumptions"])$<HTMLInputElement>(id).disabled=locked;
  $<HTMLButtonElement>("applyCalibration").disabled=locked||!$<HTMLInputElement>("calibrationAssumptions").checked||!(Number($<HTMLInputElement>("calibrationLength").value)>0);
  $<HTMLButtonElement>("clearCalibration").disabled=locked||!c;
  $("calibrationStatus").textContent=c?`${active} · ${c.edgeId}: ${fmt(c.originalLengthMm,3)} → ${fmt(c.knownLengthMm,3)} mm ／ 長さ ×${fmt(c.scaleFactor,6)}、面積 ×${fmt(c.scaleFactor*c.scaleFactor,6)}。写真・方眼は台紙座標のままです。`:'実測値による補正は未適用です。輪郭を変更した場合は補正を設定し直してください。';
  if(active!=="C"){
    journey.setMeasurementScale(c?.scaleFactor??1,journeyToken);
    journey.setReferenceEdge($<HTMLDetailsElement>("measurementCalibration").open && valid ? Number(select.value) : null,journeyToken);
  }
}
$("calibrationEdge").onchange=()=>{renderCalibration();renderCanvas();};
$("measurementCalibration").ontoggle=()=>{renderCalibration();renderCanvas();};
$("calibrationLength").oninput=()=>renderCalibration();
$("calibrationAssumptions").onchange=()=>renderCalibration();
$("applyCalibration").onclick=()=>{
  if(busy||drawing||dragging||!geometries[active]||!$<HTMLInputElement>("calibrationAssumptions").checked)return;
  try {
    const c=createKnownEdgeCalibration(geometries[active]!,Number($<HTMLSelectElement>("calibrationEdge").value),Number($<HTMLInputElement>("calibrationLength").value),{sourceEpoch,mode:active});
    calibrations[active]=c;
    syncCalibrationDiagnostic();
    render();status("既知の上面辺で計測値を補正しました。写真の輪郭と方眼は変更していません。");
  }catch(e){$("calibrationStatus").textContent=e instanceof Error?e.message:String(e);status($("calibrationStatus").textContent!,true);}
};
$("clearCalibration").onclick=()=>{if(busy)return;delete calibrations[active];debug.remove(["calibration"]);render();status("既知辺補正を解除し、元の計測値に戻しました。");};
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
        const measurementScale=currentCalibration(mode)?.scaleFactor??1;
        allRings(g).forEach((ring, ri) => {
          ring.forEach((p, i) => {
            const q = ring[(i + 1) % ring.length],
              len = Math.hypot(q.x - p.x, q.y - p.y) * measurementScale;
            html += `<text x="${(p.x + q.x) / 2}" y="${(p.y + q.y) / 2 - font * 0.7}" font-size="${font}" fill="${colors[mode]}" text-anchor="middle" stroke="#fffc" stroke-width="${font * 0.28}" paint-order="stroke">${fmt(len)} mm</text>`;
            if (ri===0 && $<HTMLDetailsElement>("measurementCalibration").open && Number($<HTMLSelectElement>("calibrationEdge").value)===i) {
              html += `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#d92778" stroke-width="${stroke*4}" pointer-events="none"/><text x="${(p.x+q.x)/2}" y="${(p.y+q.y)/2+font*1.1}" font-size="${font}" fill="#a4004c" stroke="#fff" stroke-width="${font*.2}" paint-order="stroke" text-anchor="middle">E${i+1} · 基準辺</text>`;
            }
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
  $<HTMLButtonElement>("editCurves").disabled = busy || !!drawing || !!dragging || !geometries[active] || !validateGeometry(geometries[active]!).valid;
  $("exportStatus").textContent = "";
  renderCalibration();
  renderCanvas();
  document
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === active));
  const raw = geometries[active], g = raw && validateGeometry(raw).valid ? measurementGeometry(active) : raw;
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
  $("warnings").innerHTML = [...(warnings[active] ?? []), ...(currentCalibration(active) ? ["既知の上面辺から計測値を一様補正しています。写真の輪郭・台紙方眼は未変更です。側面や残る歪みは補正できません。"] : [])]
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
      return `<div class="benchcard"><b>MODE ${m} · ${currentCalibration(m)?"既知辺補正前 · ":""}境界平均誤差</b><div style="margin-top:8px"><strong>${fmt(r.boundary_mean_mm, 2)}</strong><span class="hint"> mm</span></div><p>境界最大 ${fmt(r.boundary_max_mm, 2)} mm<br>面積誤差 ${fmt(r.area_error_percent, 2)}%<br>穴 ${g.holes.length} / 正解 ${truth!.holes.length}<br>${r.edge_length_mae_mm === null ? "辺誤差: 対応不一致" : `辺平均誤差 ${fmt(r.edge_length_mae_mm, 2)} mm`}</p>${r.hole_count_mismatch ? '<p class="warn">穴の見落とし / 個数不一致</p>' : ""}</div>`;
    })
    .join("");
}
async function calibrate(method: "A" | "B" = selectedMethod()) {
  if (!source) throw Error("先に写真を選んでください。");
  flat = undefined;
  flatUrl = "";
  gridUrl = "";
  markers = [];
  journeyMarkerReport = undefined;
  $("markerLabel").textContent = "MARKERS —";
  resetResults();
  debug.reset();
  journeyToken = journey.begin(source, board, method);
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
  processing(unifiedRunActive ? "基準平面への補正ができました。AI解析へ進みます。" : "平面補正できました。AI解析は未実行です。");
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
async function guarded(fn: () => Promise<void>, previous?: AnalysisSnapshot) {
  if (busy) return;
  // A diagnostic search can be cancelled without replacing any result. Keep
  // that already-completed result distinct from a new, partially completed
  // one-click analysis; preserve the search/cost diagnostics in either case.
  const resultsAtStart = { ...geometries };
  const epochAtStart = sourceEpoch;
  pipelineAbort = new AbortController();
  pipelineFinishMessage = undefined;
  setBusy(true);
  debug.start();
  try {
    await fn();
    pipelineAbort.signal.throwIfAborted();
    $("analysisSummary").dataset.state = geometries[active] ? "complete" : "idle";
    $("analysisSummary").dataset.method = active;
    journey.setProcessing(pipelineFinishMessage ?? (geometries[active] ? "処理完了 · 説明再生とは別の実処理です" : "解析待ち · 写真と方式を確認して開始してください"), geometries[active] ? "complete" : "idle", journeyToken);
  } catch (e) {
    const aborted =
      pipelineAbort.signal.aborted ||
      (e instanceof Error && e.name === "AbortError");
    const message = aborted
      ? "処理を中止しました。外部送信済みの場合、送信データや発生済みAPI料金は取り消せません。"
      : e instanceof Error
        ? e.message
        : String(e);
    const validRetained=!previous&&!!geometries[active]&&validateGeometry(geometries[active]!).valid;
    const unchanged=validRetained&&sourceEpoch===epochAtStart&&geometries[active]===resultsAtStart[active];
    const partial=validRetained&&!unchanged;
    if(previous)restoreAnalysis(previous, "前回の解析結果を保持しています。",true);
    else if(unchanged){
      if(active!=="C")showMethodResult(active);
    }
    else if(partial){
      provenance[active]={...provenance[active],pipeline_completion:aborted?"partial_cancelled":"partial_failed"};
      warnings[active]=[...(warnings[active]??[]),"解析の途中で停止しました。表示はここまでに取得した輪郭で、後続の調整・評価は完了していません。"];
      if(active!=="C")showMethodResult(active);
    }
    const retained=previous||unchanged?" 前回の解析結果を保持しています。":partial?" ここまでに取得した輪郭を表示しています。未完了の工程があります。":"";
    $("analysisFailure").hidden=false;
    $("analysisFailureMessage").textContent=message+retained;
    status(message+retained, !aborted);
    $("analysisSummary").dataset.state = aborted ? "cancelled" : "error";
    failureNeedsKey=e instanceof ProviderError && (e.stage==="authentication"||e.stage==="availability"||[401,402,403].includes(e.status??0));
    if(previous||unchanged||partial) {
      journey.setProcessing(message+retained,aborted?"cancelled":"error",journeyToken);
    } else if (aborted) {
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
  sourceEpoch++;
  lastAnalysis = undefined;
  $("analysisFailure").hidden = true;
  const preview = $<HTMLCanvasElement>("sourcePreview"); preview.width = preview.height = 1;
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
  status("新しい写真を読み込み中です。読み込み後に解析できます。");
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
    showPreparedSource();
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
  ensureAnalysisMethod("B");
  journey.setGeometry(result.rawGeometry, result.r.geometry, journeyToken);
  geometries.B = result.r.geometry;
  warnings.B = [...result.r.warnings,"前景AIは上面・側面・影を識別できません。台紙の平面補正だけでは厚みによる尺度誤差は解消しません。"];
  provenance.B = {
    ...provenance.B,
    epsilon_mm: result.epsilon,
    mask_threshold: result.threshold,
  };
}
function revectorize() {
  ensureAnalysisMethod("B");
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
  ensureAnalysisMethod("B");
  resetTuning();
  if (!flat) throw Error("平面補正が必要です。");
  if (journeyToken === undefined && source && journeyMarkerReport) {
    journeyToken = journey.begin(source, board, "B");
    journey.setMarkers(journeyMarkerReport, journeyToken);
    journey.setRectified(flat, homographyDetails(markers, board), journeyToken);
  }
  debug.remove(["probability", "binary", "contours", "polygon"]);
  journey.clearAnalysis(journeyToken);
  const token = journeyToken;
  delete geometries.B;
  delete provenance.B;
  delete calibrations.B;
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
  ensureAnalysisMethod("B");
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
  ensureAnalysisMethod("B");
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
    processing(reason);
    const result=await searchMaskCandidates(fixedMask,fixedBoard,{currentThreshold:Number($<HTMLInputElement>("threshold").value),currentEpsilon:Number($<HTMLInputElement>("epsilon").value),signal:pipelineAbort?.signal,onProgress:p=>{
      $("tuneStatus").textContent=`${reason} · ${p.attempts}/${p.maxCandidates}設定を処理、${p.validCandidates}候補（${(p.elapsedMs/1000).toFixed(1)}秒）`;
      if(unifiedRunActive)processing($("tuneStatus").textContent!);
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
async function runAutomaticReview(authorization?: RunAuthorization) {
  if(drawing||dragging)throw Error("編集中の図形を確定または中止してください。");
  if(!flat||!mask||!tuneResult||(!authorization?.review && !$<HTMLInputElement>("reviewConsent").checked))throw Error("候補と画像送信の確認が必要です。");
  ensureAnalysisMethod("B");
  const selectedProvider=authorization?.provider ?? provider(), key=authorization?.key ?? $<HTMLInputElement>("apiKey").value, keyError=validateProviderKey(selectedProvider,key);
  if(keyError)throw Error(keyError);
  const safe=tuneResult.candidates.find(c=>c.safeToAutoApply)??tuneResult.candidates[0];if(!safe)throw Error("幾何的に有効な候補がありません。");
  const maxCalls=authorization?.maxCalls ?? Number($<HTMLSelectElement>("reviewMaxCalls").value);if(![1,2,3].includes(maxCalls))throw Error("評価上限は1〜3回です。");
  const fixedMask=mask,fixedFlat=flat,fixedBoard=board,epoch=tuneEpoch;
  activeRequest=new AbortController();tuneRunActive=true;updateButtons();
  const signal=AbortSignal.any([activeRequest.signal,pipelineAbort!.signal]);
  const candidates=tuneResult.candidates.slice(0,4).map(toReviewCandidate),attempts:ReviewAttempt[]=[];
  tuneReview=undefined;$("reviewStatus").textContent="選択済み接続先で評価を開始します…";showReviewAttempts([]);
  try {
    const result=await runReviewLoop({initialCandidates:candidates,localFallback:toReviewCandidate(safe),maxCalls:maxCalls as 1|2|3,signal,
      evaluate:(batch,attempt,callSignal)=>reviewCandidates({provider:selectedProvider,key,consent:true,photographDataUrl:reviewPhotograph(fixedFlat),candidates:batch,signal:callSignal,progress:message=>{$("reviewStatus").textContent=`${attempt}/${maxCalls}回 · ${message}`;if(unifiedRunActive)processing($("reviewStatus").textContent!);}}),
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
  ensureAnalysisMethod("B");
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
$("reviewRun").onclick=()=>void guarded(()=>runAutomaticReview());
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
    showPreparedSource();
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
    sourceEpoch++;lastAnalysis=undefined;
    truth = undefined;
    flat = undefined;
    flatUrl = "";
    gridUrl = "";
    debug.reset();
    resetResults();
    markers=[];journeyMarkerReport=undefined;
    showPreparedSource();
    status("カスタム寸法を入力して「解析する」を押してください。");
  } else {
    board = { ...PRESETS[p] };
    truth = undefined;
    invalidateCalibration();
  }
};
for (const id of ["width", "height"])
  $<HTMLInputElement>(id).onchange = () => {
    if (busy) return;
    sourceEpoch++; lastAnalysis = undefined;
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
      showPreparedSource();
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
$("runB").onclick = () => void guarded(async () => { await runModeB(); });
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
  if (unifiedRunActive) pipelineAbort?.abort();
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
  if (unifiedRunActive) pipelineAbort?.abort();
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
  if (unifiedRunActive) pipelineAbort?.abort();
  restoreProviderKey();
  status(`接続先を${PROVIDERS[provider()].name}に変更しました。この接続先のキーだけを使用します。送信前に確認してください。`);
};
window.addEventListener("storage", (event) => {
  try { if (event.storageArea !== window.localStorage) return; } catch { return; }
  if (event.key !== null && event.key !== providerStorageKey(provider())) return;
  activeRequest?.abort();
  if (unifiedRunActive) pipelineAbort?.abort();
  restoreProviderKey();
});
async function runModeA(authorization?: RunAuthorization) {
    ensureAnalysisMethod("A");
    if (!flat || (!authorization && !$<HTMLInputElement>("consent").checked))
      throw Error("写真送信とAPI利用料の確認が必要です。");
    const selectedProvider = authorization?.provider ?? provider(),
      key = authorization?.key ?? $<HTMLInputElement>("apiKey").value,
      keyError = validateProviderKey(selectedProvider, key);
    if (keyError) throw Error(keyError);
    delete geometries.A;
    delete calibrations.A;
    delete provenance.A;
    delete warnings.A;
    active = "A";
    if(!unifiedRunActive) journey.clearAnalysis(journeyToken);
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
            surface_assessment: r.surfaceAssessment,
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
      journey.setGeometry(r.geometry, journeyToken);
      geometries.A = r.geometry;
      provenance.A = {
        method:
          r.provider === "openrouter"
            ? "OpenRouter-Chat-Completions-API"
            : "OpenAI-Responses-API",
        provider: r.provider,
        model: r.model,
        request_id: r.requestId,
        surface_assessment: r.surfaceAssessment,
        surface_target_verified: false,
        grid_step_mm: Number($<HTMLSelectElement>("gridstep").value),
        scale_mm_per_px: board.width / board.pixelWidth,
      };
      warnings.A = ["上面境界を指定して推定しましたが、上面だけを正しく抽出したことは未検証です。厚みの尺度誤差と側面・影の混入を確認してください。", "LLM座標は視覚的な推定です。製造用の精度を保証しません。", ...(r.surfaceAssessment.uncertain?["上面の境界に不確実な箇所があるとAIが報告しています。"]:[]), ...(r.surfaceAssessment.occluded_edges?["見えない上面の縁が含まれています。該当する辺の寸法は実測してください。"]:[]), ...(r.surfaceAssessment.sidewall_risk?["側面が境界に混ざる危険が報告されています。正面に近い撮影で再解析してください。"]:[])];
      active = "A";
      processing(
        "GPT-6 Lunaの実際の応答を表示しています。頂点・穴・寸法を確認してください。",
      );
    } finally {
      activeRequest = undefined;
    }
}
$("runA").onclick = () => void guarded(async()=>{ await runModeA(); });
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
      if (busy) return;
      if(b.dataset.mode==="A" || b.dataset.mode==="B"){showMethodResult(b.dataset.mode);return;}
      revealEditor("手動編集した輪郭を表示します。");
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
  delete calibrations.C;
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
        fn(measurementGeometry(active)!, board, board.preset, {
          ...provenance[active],
          app_build: APP_BUILD,
          measurement_calibration: currentCalibration(active)?.provenance ?? null,
          coordinate_space: currentCalibration(active) ? "measurement-only calibrated coordinates; photo overlays remain in original board coordinates" : "original marker-plane millimetres",
          original_geometry_mm: currentCalibration(active) ? g : undefined,
          marker_plane_mm_per_px: {x:board.width/board.pixelWidth,y:board.height/board.pixelHeight},
          svg_export_bounds_mm: svgExportBounds(measurementGeometry(active)!,board),
          export_translation_mm: {x:0,y:0},
          scale_mm_per_px: board.width / board.pixelWidth * (currentCalibration(active)?.scaleFactor ?? 1),
          source_image: sampleId || "user-upload",
          scale_y_mm_per_px: board.height / board.pixelHeight * (currentCalibration(active)?.scaleFactor ?? 1),
        }),
        type,
        ext,
      );
      $("exportStatus").classList.remove("error");
      $("exportStatus").textContent=`${ext.toUpperCase()}を実寸mmで書き出しました${currentCalibration(active)?"（既知の上面辺による計測値補正を適用）":""}。`;
    } catch (e) {
      $("exportStatus").classList.add("error");
      $("exportStatus").textContent=String(e);
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

$("editCurves").onclick=()=>{if(busy||drawing||dragging)return;const g=measurementGeometry(active);if(g&&validateGeometry(g).valid)openCurveEditor(g,board,{...provenance[active],manual_curve_edit:true,measurement_calibration:currentCalibration(active)?.provenance??null},flatUrl?{url:flatUrl,scale:currentCalibration(active)?.scaleFactor??1,anchor:currentCalibration(active)?.anchor??{x:0,y:0}}:undefined,geometries[active]!);};
