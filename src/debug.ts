import { APP_BUILD } from "./build-info";
import {
  canvas,
  type MarkerDetectionReport,
  type Board,
  type MaskResult,
  type MaskTrace,
} from "./vision";
import { geometryArea, type Geometry, type Point } from "./geometry";
export type DebugStageId =
  | "input"
  | "markers"
  | "rectified"
  | "grid"
  | "probability"
  | "binary"
  | "contours"
  | "polygon"
  | "api"
  | "tuning"
  | "calibration";
export interface DebugStage {
  id: DebugStageId;
  title: string;
  image?: string;
  elapsedMs?: number;
  details: Record<string, unknown>;
  state?: "complete" | "error";
}
const labels: Record<DebugStageId, string> = {
  input: "入力写真",
  markers: "ArUco検出",
  rectified: "平面補正",
  grid: "方眼",
  probability: "AI確率",
  binary: "2値マスク",
  contours: "生の輪郭",
  polygon: "実寸ポリゴン",
  api: "外部API",
  tuning: "自動調整",
  calibration: "既知辺補正",
};
export class DebugPanel {
  private stages = new Map<DebugStageId, DebugStage>();
  private selected: DebugStageId | undefined;
  private release?: () => void;
  private running = false;
  private activeText = "まだ処理していません";
  private waitId?: DebugStageId;
  private log: { at_ms: number; message: string }[] = [];
  private started = performance.now();
  constructor(
    private root: HTMLElement,
    private cancel: () => void,
    private runAll: () => void,
  ) {
    root.innerHTML = `<div class="debug-head"><div><h2>処理を見ながら検証</h2><p>実際に処理した画像・数値だけを表示。未実行の工程は空欄です。</p></div><span class="pill">LIVE DEBUG</span></div><div class="debug-controls"><label><input id="debugStep" type="checkbox"> 1工程ずつ止める</label><button id="debugRun">入力からBまで実行</button><button id="debugNext" disabled>次の工程 →</button><button id="debugContinue" disabled>連続実行</button><button id="debugCancel" disabled>中止</button><button id="debugExport" disabled>診断JSON</button></div><div id="debugActivity" class="debug-activity" role="status" aria-live="polite"></div><div id="debugStages" class="debug-stages"></div><div class="debug-inspector"><div class="debug-preview"><img id="debugImage" alt="実際の処理結果"><span id="debugEmpty">工程を選ぶと処理結果が表示されます。</span></div><div><div id="debugCaption" class="debug-caption"></div><pre id="debugDetails" class="debug-details"></pre></div></div><details class="debug-log"><summary>実行ログ（キー・通信本文は記録しません）</summary><pre id="debugLog"></pre></details>`;
    this.el<HTMLButtonElement>("debugNext").onclick = () => this.release?.();
    this.el<HTMLButtonElement>("debugContinue").onclick = () => {
      this.el<HTMLInputElement>("debugStep").checked = false;
      this.release?.();
      this.render();
    };
    this.el<HTMLInputElement>("debugStep").onchange = () => {
      if (!this.el<HTMLInputElement>("debugStep").checked) this.release?.();
      this.render();
    };
    this.el<HTMLButtonElement>("debugCancel").onclick = () => cancel();
    this.el<HTMLButtonElement>("debugRun").onclick = () => runAll();
    this.el<HTMLButtonElement>("debugExport").onclick = () => {
      const blob = new Blob([JSON.stringify(this.report(), null, 2)], {
          type: "application/json",
        }),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = "scrap-diagnostics.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    this.render();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) {
    return this.root.querySelector<T>(`#${id}`)!;
  }
  report() {
    return {
      version: 1,
      app_build: APP_BUILD,
      stages: [...this.stages.values()].map(({ image, ...stage }) => stage),
      log: this.log,
      notice:
        "Only processing metadata. Images, keys, HTTP bodies and user filenames are excluded.",
    };
  }
  remove(ids: DebugStageId[]) {
    for (const id of ids) this.stages.delete(id);
    if (this.selected && !this.stages.has(this.selected))
      this.selected = undefined;
    this.render();
  }
  reset() {
    this.el("debugActivity").classList.remove("error");
    this.stages.clear();
    this.selected = undefined;
    this.log = [];
    this.started = performance.now();
    this.activeText = "新しい入力";
    this.render();
  }
  start() {
    this.running = true;
    this.log = [];
    this.el("debugActivity").classList.remove("error");
    this.started = performance.now();
    this.render();
  }
  finish() {
    this.running = false;
    this.waitId = undefined;
    this.release?.();
    this.release = undefined;
    this.render();
  }
  progress(message: string) {
    this.activeText = message;
    this.log.push({
      at_ms: Math.round(performance.now() - this.started),
      message,
    });
    if (this.log.length > 40) this.log.shift();
    this.renderActivity();
  }
  fail(message: string, details?: Record<string, unknown>) {
    this.progress(message);
    this.el("debugActivity").classList.add("error");
    if (details)
      this.record({ id: "api", title: "APIエラー", details, state: "error" });
  }
  record(stage: DebugStage) {
    this.stages.set(stage.id, stage);
    this.selected = stage.id;
    this.render();
  }
  async checkpoint(stage: DebugStage, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.record(stage);
    this.progress(`${stage.title}を確認できます。`);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    signal?.throwIfAborted();
    if (!this.el<HTMLInputElement>("debugStep").checked) return;
    this.waitId = stage.id;
    this.activeText = `${stage.title}で停止中。「次の工程」で実際の処理を進めます。`;
    this.render();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.release = undefined;
        this.waitId = undefined;
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      this.release = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
        this.render();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      this.render();
    });
  }
  private renderActivity() {
    this.el("debugActivity").textContent = this.activeText;
    this.el("debugLog").textContent = this.log
      .map((row) => `${(row.at_ms / 1000).toFixed(2)} s  ${row.message}`)
      .join("\n");
  }
  private render() {
    const steps = this.el("debugStages");
    steps.replaceChildren();
    for (const id of Object.keys(labels) as DebugStageId[]) {
      const stage = this.stages.get(id),
        button = document.createElement("button");
      button.textContent = `${stage ? (stage.state === "error" ? "✕ " : "✓ ") : ""}${labels[id]}`;
      button.dataset.stage = id;
      button.disabled = !stage;
      button.classList.toggle("active", id === this.selected);
      button.classList.toggle("failed", stage?.state === "error");
      button.onclick = () => {
        this.selected = id;
        this.render();
      };
      steps.append(button);
    }
    const selected = this.selected ? this.stages.get(this.selected) : undefined,
      img = this.el<HTMLImageElement>("debugImage");
    img.hidden = !selected?.image;
    if (selected?.image) img.src = selected.image;
    else img.removeAttribute("src");
    this.el("debugEmpty").hidden = !!selected?.image;
    this.el("debugCaption").textContent = selected
      ? `${selected.title}${selected.elapsedMs === undefined ? "" : ` · ${selected.elapsedMs.toFixed(1)} ms（実測）`}`
      : "工程を選択";
    this.el("debugDetails").textContent = selected
      ? JSON.stringify(
          selected.details,
          (_key, value) =>
            typeof value === "number" && Number.isFinite(value)
              ? Math.round(value * 1e5) / 1e5
              : value,
          2,
        )
      : "";
    this.el<HTMLButtonElement>("debugNext").disabled = !this.release;
    this.el<HTMLButtonElement>("debugContinue").disabled = !this.running;
    this.el<HTMLButtonElement>("debugCancel").disabled = !this.running;
    this.el<HTMLButtonElement>("debugRun").disabled = this.running;
    this.el<HTMLButtonElement>("debugExport").disabled = !this.stages.size;
    this.renderActivity();
  }
}
export function markerDebugImage(
  source: HTMLCanvasElement,
  report: MarkerDetectionReport,
): string {
  const c = canvas(source.width, source.height),
    ctx = c.getContext("2d")!;
  ctx.drawImage(source, 0, 0);
  ctx.lineWidth = Math.max(2, c.width / 700);
  ctx.font = `bold ${Math.max(15, c.width / 65)}px monospace`;
  const draw = (ring: Point[], color: string, dashed = false) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(dashed ? [8, 6] : []);
    ctx.beginPath();
    ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  };
  for (const rejected of report.rejectedCandidates)
    draw(rejected, "#ffb735", true);
  for (const marker of report.decodedMarkers) {
    draw(marker.corners, "#17e18b");
    marker.corners.forEach((p, i) => {
      ctx.fillStyle = i === [2, 3, 0, 1][marker.id] ? "#ff5d53" : "#fff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, c.width / 250, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#094d32";
      ctx.fillText(`${marker.id}:${i}`, p.x + 5, p.y - 5);
    });
  }
  return c.toDataURL("image/jpeg", 0.92);
}
export function maskDebugImage(mask: MaskResult, threshold?: number): string {
  const c = canvas(mask.width, mask.height),
    ctx = c.getContext("2d")!,
    data = ctx.createImageData(mask.width, mask.height);
  mask.probabilities.forEach((v, i) => {
    const value =
      threshold === undefined ? Math.round(v * 255) : v >= threshold ? 255 : 0;
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = value;
    data.data[i * 4 + 3] = 255;
  });
  ctx.putImageData(data, 0, 0);
  return c.toDataURL();
}
export function geometryDebugImage(
  source: HTMLCanvasElement,
  board: Board,
  geometry: Geometry,
  dimensions = false,
  trace?: MaskTrace,
): string {
  const width = Math.min(1200, source.width),
    height = Math.round((width * board.height) / board.width),
    c = canvas(width, height),
    ctx = c.getContext("2d")!;
  ctx.drawImage(source, 0, 0, width, height);
  ctx.fillStyle = "#ffffff44";
  ctx.fillRect(0, 0, width, height);
  const sx = width / board.width,
    sy = height / board.height;
  const rings = trace
    ? trace.contours.map((contour) => ({
        points: contour.points,
        color: contour.hole ? "#0085c9" : "#f0842a",
      }))
    : [geometry.outer, ...geometry.holes].map((points, index) => ({
        points,
        color: index ? "#0085c9" : "#165d39",
      }));
  ctx.lineWidth = dimensions ? 2 : 1;
  ctx.font = `${Math.max(10, width / 75)}px monospace`;
  for (const { points, color } of rings) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    points.forEach((p, i) =>
      i ? ctx.lineTo(p.x * sx, p.y * sy) : ctx.moveTo(p.x * sx, p.y * sy),
    );
    ctx.closePath();
    ctx.stroke();
    if (dimensions)
      points.forEach((p, i) => {
        const q = points[(i + 1) % points.length];
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x * sx, p.y * sy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(
          `${Math.hypot(q.x - p.x, q.y - p.y).toFixed(1)}mm`,
          ((p.x + q.x) / 2) * sx,
          ((p.y + q.y) / 2) * sy - 7,
        );
      });
  }
  if (dimensions) {
    ctx.fillStyle = "#113c27";
    ctx.fillText(
      `net ${geometryArea(geometry).toFixed(1)} mm²`,
      12,
      height - 14,
    );
  }
  return c.toDataURL("image/jpeg", 0.92);
}
