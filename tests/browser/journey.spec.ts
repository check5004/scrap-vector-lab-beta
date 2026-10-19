import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { legacyReady, openEditor, startLegacyCalibration } from "./legacy-ui";

type Point = { x: number; y: number };
type Stage = {
  id: string;
  elapsedMs?: number;
  state?: "complete" | "error";
  details: Record<string, any>;
};
type DiagnosticReport = { stages: Stage[]; log: { at_ms: number; message: string }[] };

const neuralTimeout = 150_000;
const ready = legacyReady;
const infer = async (page: Page) => {
  await page.locator("#runB").click();
  await expect(page.locator("#status")).toContainText("実際のU²-NetP推論が完了", { timeout: neuralTimeout });
  await expect(page.locator("#exportJson")).toBeEnabled();
};
const downloadJSON = async <T>(page: Page, selector: string): Promise<T> => {
  const pending = page.waitForEvent("download");
  await page.locator(selector).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error("The browser did not create the JSON download");
  return JSON.parse(await readFile(path, "utf8")) as T;
};
const stage = (report: DiagnosticReport, id: string): Stage => {
  const result = report.stages.find((entry) => entry.id === id);
  expect(result, `Real pipeline diagnostic stage ${id}`).toBeDefined();
  return result!;
};
function project(h: number[], p: Point): Point {
  const d = h[6] * p.x + h[7] * p.y + (h[8] ?? 1);
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / d, y: (h[3] * p.x + h[4] * p.y + h[5]) / d };
}
function expectPoints(actual: Point[], expected: Point[], tolerance = 1e-4) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(Math.abs(actual[i].x - expected[i].x), `point ${i} x`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(actual[i].y - expected[i].y), `point ${i} y`).toBeLessThanOrEqual(tolerance);
  }
}

// Install before navigation: accidental provider/CDN requests are aborted, never paid.
// Same-origin model, WASM, dictionary and image bytes are not mocked or replaced.
async function localOnly(context: BrowserContext, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const blocked: string[] = [];
  await context.route(/^https?:\/\//, async (route) => {
    const url = route.request().url();
    if (new URL(url).origin !== origin) {
      blocked.push(url);
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  return blocked;
}

let offOrigin: string[];
let pageErrors: string[];
test.beforeEach(async ({ page, context, baseURL }) => {
  offOrigin = await localOnly(context, baseURL!);
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(offOrigin, "Journey must not request any off-origin resource").toEqual([]);
  expect(pageErrors, "Journey must not throw a browser error").toEqual([]);
});

const journey = (page: Page) => page.locator("#journey-root");
const available = (page: Page, id: string) => page.locator(`[data-journey-step="${id}"]`);
const selectStage = async (page: Page, id: string) => {
  await available(page, id).click();
  await expect(journey(page)).toHaveAttribute("data-stage", id);
};
const noAnalysis = async (page: Page) => {
  for (const id of ["mask", "contour", "dimensions"]) await expect(available(page, id)).toHaveCount(0);
  for (const kind of ["raw", "simplified"]) {
    const path = page.locator(`#journeyOverlay [data-contour="${kind}"]`);
    await expect(path).not.toHaveAttribute("data-geometry-mm", /.*/);
    await expect(path).toHaveAttribute("d", "");
  }
  await expect(page.locator("#journeyOverlay [data-mm]")).toHaveCount(0);
};
const pointsFromAttribute = async (page: Page, selector: string, attribute: string): Promise<Point[]> => {
  const value = await page.locator(selector).getAttribute(attribute);
  expect(value, `${selector} ${attribute}`).not.toBeNull();
  return JSON.parse(value!);
};
async function setRange(page: Page, id: string, value: string) {
  await page.locator(`#${id}`).evaluate((element, next) => {
    const input = element as HTMLInputElement;
    input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
async function expectPlaneMapping(page: Page) {
  const map = await page.locator("#journeyPlane").evaluate((node) => {
    const plane = node as HTMLElement;
    const image = plane.querySelector<HTMLCanvasElement>("#journeyRectified")!;
    const viewport = plane.parentElement!;
    const origin = viewport.getBoundingClientRect();
    const overlay = document.querySelector<SVGSVGElement>("#journeyOverlay")!;
    const cssWidth = parseFloat(plane.style.width), cssHeight = parseFloat(plane.style.height);
    // Probe actual browser geometry. Computed-style matrix text is a lossy
    // serialization, and tiny perspective terms can also lose CSS precision.
    // These transient, empty DOM elements do not alter any image/model data.
    const renderedCorners = [[0, 0], [cssWidth, 0], [cssWidth, cssHeight], [0, cssHeight]].map(([x, y]) => {
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;display:block;left:${x}px;top:${y}px;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;`;
      plane.append(probe);
      const bounds = probe.getBoundingClientRect();
      probe.remove();
      return { x: bounds.left - origin.left, y: bounds.top - origin.top };
    });
    const bounds = image.getBoundingClientRect();
    return {
      matrix: JSON.parse(plane.dataset.transform!), corners: JSON.parse(plane.dataset.corners!),
      cssMatrix: JSON.parse(plane.dataset.cssTransform!), cssSize: JSON.parse(plane.dataset.cssSize!),
      width: image.width, height: image.height, cssWidth, cssHeight, renderedCorners,
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
      viewBox: { width: overlay.viewBox.baseVal.width, height: overlay.viewBox.baseVal.height },
      renderedBounds: { left: bounds.left - origin.left, top: bounds.top - origin.top, right: bounds.right - origin.left, bottom: bounds.bottom - origin.top },
    };
  });
  expect(map.matrix).toHaveLength(9);
  expect(map.matrix.every(Number.isFinite)).toBeTruthy();
  expect(map.viewBox).toEqual(map.viewport);
  expect(map.viewport.width).toBeGreaterThan(0);
  expect(map.viewport.height).toBeGreaterThan(0);
  expect(map.cssWidth).toBeGreaterThan(0);
  expect(map.cssHeight).toBeGreaterThan(0);
  expect(map.cssSize).toEqual([100, 100]);
  expect([map.cssWidth, map.cssHeight]).toEqual(map.cssSize);
  const cssCorners = [{ x: 0, y: 0 }, { x: map.cssWidth, y: 0 }, { x: map.cssWidth, y: map.cssHeight }, { x: 0, y: map.cssHeight }];
  expectPoints(cssCorners.map((p) => project(map.cssMatrix, p)), map.corners, 1e-7);
  const corners = [{ x: 0, y: 0 }, { x: map.width, y: 0 }, { x: map.width, y: map.height }, { x: 0, y: map.height }];
  expectPoints(corners.map((p) => project(map.matrix, p)), map.corners, 1e-7);
  // Keep the original strict screen-space budget, now measured from real layout.
  expectPoints(map.renderedCorners, map.corners, 0.05);
  const expectedBounds = {
    left: Math.min(...map.corners.map((p: Point) => p.x)), top: Math.min(...map.corners.map((p: Point) => p.y)),
    right: Math.max(...map.corners.map((p: Point) => p.x)), bottom: Math.max(...map.corners.map((p: Point) => p.y)),
  };
  for (const key of ["left", "top", "right", "bottom"] as const)
    expect(Math.abs(map.renderedBounds[key] - expectedBounds[key]), `painted image ${key}`).toBeLessThanOrEqual(0.05);
  const reference = await page.locator("#journeyOverlay [data-reference-quad]").evaluate((node) =>
    Array.from((node as SVGPolygonElement).points).map((point) => ({ x: point.x, y: point.y })));
  expectPoints(reference, map.corners, 0.002);
  return map;
}
async function expectRectifiedPixels(page: Page) {
  await page.locator('#debugStages [data-stage="rectified"]').click();
  const image = await page.evaluate(async () => {
    const target = document.querySelector<HTMLCanvasElement>("#journeyRectified")!;
    const source = document.querySelector<HTMLImageElement>("#debugImage")!;
    await source.decode();
    const size = 128;
    const sample = (input: CanvasImageSource) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
      const context = canvas.getContext("2d")!;
      context.drawImage(input, 0, 0, size, size);
      return context.getImageData(0, 0, size, size).data;
    };
    const actual = sample(target), expected = sample(source);
    let difference = 0, samples = 0;
    for (let i = 0; i < actual.length; i++) if (i % 4 !== 3) { difference += Math.abs(actual[i] - expected[i]); samples++; }
    return { target: [target.width, target.height], source: [source.naturalWidth, source.naturalHeight], meanDifference: difference / samples };
  });
  expect(image.target).toEqual(image.source);
  // Diagnostics encode the same real rectification as JPEG; allow its quantization only.
  expect(image.meanDifference).toBeLessThan(4);
}
async function expectNeuralMaskPixels(page: Page) {
  await page.locator('#debugStages [data-stage="probability"]').click();
  const pixels = await page.evaluate(async () => {
    const target = document.querySelector<HTMLCanvasElement>("#journeyMask")!;
    const source = document.querySelector<HTMLImageElement>("#debugImage")!;
    await source.decode();
    const probability = document.createElement("canvas"); probability.width = source.naturalWidth; probability.height = source.naturalHeight;
    const context = probability.getContext("2d")!; context.drawImage(source, 0, 0);
    const values = context.getImageData(0, 0, probability.width, probability.height).data;
    const rendered = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
    let foreground = 0, mismatches = 0, invalidAlpha = 0;
    for (let i = 0; i < rendered.length; i += 4) {
      const alpha = rendered[i + 3];
      if (alpha === 190) foreground++;
      if (alpha !== 0 && alpha !== 190) invalidAlpha++;
      // PNG stores round(probability*255); only the two quantized threshold bins are ambiguous.
      if ((values[i] < 127 && alpha !== 0) || (values[i] > 128 && alpha !== 190)) mismatches++;
    }
    return { width: target.width, height: target.height, foreground, mismatches, invalidAlpha, threshold: target.dataset.threshold };
  });
  expect([pixels.width, pixels.height]).toEqual([320, 320]);
  expect(pixels.threshold).toBe("0.5");
  expect(pixels.foreground).toBeGreaterThan(10_000);
  expect(pixels.foreground).toBeLessThan(70_000);
  expect(pixels.mismatches).toBe(0);
  expect(pixels.invalidAlpha).toBe(0);
}
function polygonArea(points: Point[]) {
  return Math.abs(points.reduce((sum, p, index) => {
    const q = points[(index + 1) % points.length];
    return sum + p.x * q.y - p.y * q.x;
  }, 0)) / 2;
}

test("the main journey uses real ArUco, ONNX, contour and millimetre artifacts", async ({ page }, info) => {
  await page.goto("/");
  await ready(page);
  await expect(journey(page)).toBeVisible();
  await expect(page.locator("#editorSurface")).toBeHidden();
  await expect(journey(page)).toHaveAttribute("data-processing", "idle");
  await noAnalysis(page);

  const calibrated = await downloadJSON<DiagnosticReport>(page, "#debugExport");
  const detected = stage(calibrated, "markers");
  expect(detected.details.missing_ids).toEqual([]);
  expect(detected.details.selected.map((marker: any) => marker.id)).toEqual([0, 1, 2, 3]);
  expect(detected.elapsedMs).toBeGreaterThan(0);
  await selectStage(page, "source");
  await journey(page).screenshot({ path: info.outputPath("journey-01-source.png") });
  await selectStage(page, "markers");
  await journey(page).screenshot({ path: info.outputPath("journey-02-actual-markers.png") });
  for (const marker of detected.details.selected) {
    expectPoints(await pointsFromAttribute(page, `#journeyOverlay [data-marker-id="${marker.id}"]`, "data-source-corners"), marker.corners);
  }
  const homography = stage(calibrated, "rectified").details;
  expectPoints(await pointsFromAttribute(page, "#journeyOverlay [data-reference-quad]", "data-source-corners"), homography.source_points_px);
  expect(homography.reference_corner_indices).toEqual([2, 3, 0, 1]);
  expectPoints(homography.source_points_px, detected.details.selected.map((marker: any, index: number) => marker.corners[[2, 3, 0, 1][index]]));
  expectPoints(homography.source_points_px.map((p: Point) => project(homography.source_to_rectified_h, p)), homography.destination_points_px, 1e-6);

  // Hold a genuine in-between frame. Starting inference must not corrupt its stage index
  // or resume the explanation, and the real worker must still be allowed to complete.
  await page.locator("#journeyPlay").click();
  await page.waitForFunction(() => {
    const value = Number(document.querySelector<HTMLElement>("#journey-root")!.dataset.position);
    return value > 1.2 && value < 1.8;
  });
  await page.locator("#journeyPlay").click();
  await expect(journey(page)).toHaveAttribute("data-playback", "paused");
  const position = await journey(page).getAttribute("data-position");
  const heldStage = await journey(page).getAttribute("data-stage");
  expect(Number(position)).toBeGreaterThan(1);
  expect(Number(position)).toBeLessThan(2);
  await infer(page);
  await expect(journey(page)).toHaveAttribute("data-processing", "complete");
  await expect(journey(page)).toHaveAttribute("data-playback", "paused");
  await expect(journey(page)).toHaveAttribute("data-position", position!);
  await expect(journey(page)).toHaveAttribute("data-stage", heldStage!);
  await page.locator("#journeySkip").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "dimensions");

  const report = await downloadJSON<DiagnosticReport>(page, "#debugExport");
  const neural = stage(report, "probability"), traced = stage(report, "contours"), polygon = stage(report, "polygon");
  expect(neural.details.model).toBe("U2NetP");
  expect(neural.details.model_sha256).toBe("309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8");
  expect(neural.details.native_mask_size_px).toEqual([320, 320]);
  expect(neural.details.timings_ms.inference).toBeGreaterThan(0);
  expect(neural.elapsedMs).toBeGreaterThan(0);
  expect(report.stages.map((entry) => entry.id)).toEqual(["input", "markers", "rectified", "grid", "probability", "binary", "contours", "polygon"]);
  expect(polygon.details.net_area_mm2).toBeGreaterThan(10_000);
  expect(polygon.details.net_area_mm2).toBeLessThan(15_500);

  const exported = await downloadJSON<any>(page, "#exportJson");
  expect(exported.provenance.method).toBe("U2NetP-ONNX-WASM");
  expect(exported.total_area_mm2).toBeCloseTo(polygon.details.net_area_mm2, 6);
  const simplified = JSON.parse((await page.locator('#journeyOverlay [data-contour="simplified"]').getAttribute("data-geometry-mm"))!);
  expectPoints(simplified.outer, polygon.details.outer_vertices_mm);
  expectPoints(simplified.outer, exported.outer_vertices_mm);
  expect(simplified.holes).toEqual(polygon.details.holes_vertices_mm);
  const raw = JSON.parse((await page.locator('#journeyOverlay [data-contour="raw"]').getAttribute("data-geometry-mm"))!);
  const largest = traced.details.contours.filter((contour: any) => !contour.hole)
    .sort((a: any, b: any) => polygonArea(b.vertices_mm) - polygonArea(a.vertices_mm))[0];
  expectPoints(raw.outer, largest.vertices_mm);
  expect(raw.outer.length).toBeGreaterThan(simplified.outer.length);
  // Pixel-centre mapping uses independent x/y scales for the non-square board.
  for (const p of raw.outer as Point[]) {
    const x = p.x * 320 / 250 - 0.5, y = p.y * 320 / 170 - 0.5;
    expect(Math.abs(x - Math.round(x))).toBeLessThan(1e-6);
    expect(Math.abs(y - Math.round(y))).toBeLessThan(1e-6);
  }
  const actualLengths = await page.locator("#journeyOverlay [data-mm]").evaluateAll((nodes) =>
    nodes.map((node) => Number((node as SVGElement).dataset.mm)));
  const expectedLengths = [simplified.outer, ...simplified.holes].flatMap((ring: Point[]) => ring.map((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return Math.hypot(q.x - p.x, q.y - p.y);
  }));
  expect(actualLengths).toHaveLength(expectedLengths.length);
  actualLengths.forEach((length, i) => expect(length).toBeCloseTo(expectedLengths[i], 5));
  const plane = await expectPlaneMapping(page);
  const screenVertices = await page.locator("#journeyOverlay [data-vertex-mm]").evaluateAll((nodes) => nodes.map((node) => ({
    point: JSON.parse((node as SVGElement).dataset.vertexMm!), x: Number(node.getAttribute("cx")), y: Number(node.getAttribute("cy")),
  })));
  for (const vertex of screenVertices) {
    const expected = project(plane.matrix, { x: vertex.point.x * plane.width / 250, y: vertex.point.y * plane.height / 170 });
    expectPoints([vertex], [expected], 1e-7);
  }
  await expectRectifiedPixels(page);
  await expectNeuralMaskPixels(page);
  await expect(page.locator("#warnings")).toContainText("穴");
  await journey(page).screenshot({ path: info.outputPath("journey-07-dimensions.png") });
  for (const id of ["crop", "rectify", "mask", "contour"]) {
    await selectStage(page, id);
    await journey(page).screenshot({ path: info.outputPath(`journey-${id}-real-artifact.png`) });
  }

  // A replay consumes the same immutable real artifacts; no fresh inference occurs.
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.locator("#journeyReplay").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "source");
  await expect(journey(page)).toHaveAttribute("data-playback", "playing");
  await page.locator("#journeyPlay").click();
  await expect(journey(page)).toHaveAttribute("data-playback", "paused");
  const paused = await journey(page).getAttribute("data-position");
  await page.waitForTimeout(300); // Proves the RAF clock stays held, not an inference timeout.
  await expect(journey(page)).toHaveAttribute("data-position", paused!);
  await page.locator("#journeySkip").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "dimensions");
  expect(await downloadJSON<DiagnosticReport>(page, "#debugExport")).toEqual(report);
  expect(requests).toEqual([]);
  await page.screenshot({ path: info.outputPath("continuous-real-measurement.png"), fullPage: true });
});

test("visual skip never runs unavailable stages or releases a real processing step", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.locator("#debugStep").check();
  await page.locator("#debugRun").click();
  await expect(page.locator("#debugActivity")).toContainText("入力写真で停止中");
  await expect(journey(page)).toHaveAttribute("data-processing", "running");
  await page.locator("#journeySkip").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "source");
  await expect(page.locator("#debugActivity")).toContainText("入力写真で停止中");
  await expect(page.locator("#runB")).toBeDisabled();
  for (const id of ["markers", "crop", "rectify", "mask", "contour", "dimensions"])
    await expect(available(page, id)).toHaveCount(0);
  await page.locator("#debugNext").click();
  await expect(page.locator("#debugActivity")).toContainText("ArUco検出・候補で停止中");
  await expect(available(page, "markers")).toBeEnabled();
  await noAnalysis(page);
  await expect(available(page, "rectify")).toHaveCount(0);
  await page.locator("#journeySkip").click();
  await expect(page.locator("#debugActivity")).toContainText("ArUco検出・候補で停止中");
  await expect(page.locator("#analysisCancel")).toBeVisible();
  await page.locator("#analysisCancel").click();
  await expect(page.locator("#status")).toContainText("中止");
  await expect(journey(page)).toHaveAttribute("data-processing", "cancelled");
  await noAnalysis(page);
  await expect(page.locator("#exportJson")).toBeDisabled();
  await expect(page.locator('[data-sample="notched"]')).toBeEnabled();
});

test("switching samples during playback replaces every prior-run artifact", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const oldRun = await journey(page).getAttribute("data-run-id");
  await page.locator("#journeyReplay").click();
  await expect(journey(page)).toHaveAttribute("data-playback", "playing");
  await expect(page.locator('[data-sample="notched"]')).toBeEnabled();
  await page.locator('[data-sample="notched"]').click();
  await ready(page);
  await expect(journey(page)).not.toHaveAttribute("data-run-id", oldRun!);
  await noAnalysis(page);
  const report = await downloadJSON<DiagnosticReport>(page, "#debugExport");
  expect(stage(report, "input").details.source).toBe("notched");
  expect(stage(report, "markers").details.missing_ids).toEqual([]);
  await selectStage(page, "markers");
  for (const marker of stage(report, "markers").details.selected)
    expectPoints(await pointsFromAttribute(page, `#journeyOverlay [data-marker-id="${marker.id}"]`, "data-source-corners"), marker.corners);
  await page.locator("#journeySkip").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "rectify");
  await expect(page.locator("#area")).toHaveText("—");
});

test("revectorizing, manual editing, rerunning and failed uploads cannot replay stale dimensions", async ({ page }, info) => {
  test.setTimeout(330_000); // Two genuine inference passes, each with its own bounded wait.
  test.skip(info.project.name === "mobile", "The full edit/rerun matrix runs once; mobile has its own real inference journey");
  await page.goto("/");
  await ready(page);
  await infer(page);
  // Reach the real terminal frame through animation, not Skip. Later parameter
  // changes must not inherit a hidden "playing" flag and restart the timeline.
  await selectStage(page, "contour");
  await page.locator("#journeyPlay").click();
  await expect(journey(page)).toHaveAttribute("data-playback", "complete");
  const initial = await downloadJSON<DiagnosticReport>(page, "#debugExport");

  await setRange(page, "epsilon", "5");
  await expect(journey(page)).toHaveAttribute("data-stage", "dimensions");
  await expect(journey(page)).toHaveAttribute("data-playback", "complete");
  const revisionPosition = await journey(page).getAttribute("data-position");
  await page.waitForTimeout(300);
  await expect(journey(page)).toHaveAttribute("data-position", revisionPosition!);
  const revised = await downloadJSON<DiagnosticReport>(page, "#debugExport");
  expect(stage(revised, "polygon").details.epsilon_mm).toBe(5);
  expect(stage(revised, "probability")).toEqual(stage(initial, "probability"));
  await selectStage(page, "dimensions");
  const simplified = JSON.parse((await page.locator('#journeyOverlay [data-contour="simplified"]').getAttribute("data-geometry-mm"))!);
  expectPoints(simplified.outer, stage(revised, "polygon").details.outer_vertices_mm);

  await openEditor(page);
  await page.locator("#editC").click();
  await expect(page.locator("#editorSurface")).toBeVisible();
  await expect(journey(page)).toHaveAttribute("data-playback", "editing");
  await noAnalysis(page);
  const position = await journey(page).getAttribute("data-position");
  const vertices = Number(await page.locator("#vertices").innerText());
  const edge = page.locator("#editor [data-edge]").first();
  await edge.scrollIntoViewIfNeeded();
  const box = await edge.boundingBox();
  if (!box) throw Error("No actual editable contour edge");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#vertices")).toHaveText(String(vertices + 1));
  await expect(journey(page)).toHaveAttribute("data-playback", "editing");
  await expect(journey(page)).toHaveAttribute("data-position", position!);
  const edited = await downloadJSON<any>(page, "#exportJson");
  expect(edited.provenance.method).toBe("human-edited");
  expect(edited.outer_vertices_mm).toHaveLength(vertices + 1);
  await noAnalysis(page);
  await page.locator("#journeyReplay").click();
  await page.locator("#journeySkip").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "rectify");
  await noAnalysis(page);

  // A new real inference invalidates old B artifacts immediately, even if cancelled.
  await page.locator("#debugStep").check();
  await page.locator("#runB").click();
  await expect(journey(page)).toHaveAttribute("data-processing", "running");
  await expect(page.locator("#debugActivity")).toContainText("実ニューラル推論の確率画像で停止中", { timeout: neuralTimeout });
  await expect(available(page, "mask")).toBeEnabled();
  await page.locator("#debugCancel").click();
  await expect(page.locator("#status")).toContainText("中止");
  await expect(journey(page)).toHaveAttribute("data-processing", "cancelled");
  await noAnalysis(page);
  // C can intentionally survive a B rerun; switching to B must never expose an old B result.
  await page.locator('[data-mode="B"]').click();
  await expect(page.locator("#area")).toHaveText("—");
  await expect(page.locator("#exportJson")).toBeDisabled();
  await setRange(page, "epsilon", "6");
  await noAnalysis(page);

  await page.locator("#debugStep").uncheck();
  await page.locator("#file").setInputFiles({
    name: "no-markers.svg", mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="white"/></svg>'),
  });
  await startLegacyCalibration(page);
  await expect(page.locator("#status")).toContainText("見つかりません");
  await expect(journey(page)).toHaveAttribute("data-processing", "error");
  await noAnalysis(page);
  await expect(available(page, "crop")).toHaveCount(0);
  await expect(available(page, "rectify")).toHaveCount(0);
  await expect(page.locator("#runB")).toBeDisabled();
  await expect(page.locator("#exportJson")).toBeDisabled();
  const failed = await downloadJSON<DiagnosticReport>(page, "#debugExport");
  expect(stage(failed, "markers").details.missing_ids).toEqual([0, 1, 2, 3]);
  expect(failed.stages.map((entry) => entry.id)).toEqual(["input", "markers"]);
});

test("reduced motion presents stable real stages and retains the full inference result", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Reduced-motion inference once on desktop; touch/overflow runs separately");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  await expect(journey(page)).toHaveAttribute("data-reduced-motion", "true");
  await expect(journey(page)).toHaveAttribute("data-playback", "reduced-motion");
  await noAnalysis(page);
  const before = await journey(page).getAttribute("data-position");
  await page.waitForTimeout(300);
  await expect(journey(page)).toHaveAttribute("data-position", before!);
  await infer(page);
  await page.locator("#journeySkip").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "dimensions");
  await expect(journey(page)).toHaveAttribute("data-playback", "reduced-motion");
  const end = await journey(page).getAttribute("data-position");
  await page.waitForTimeout(300);
  await expect(journey(page)).toHaveAttribute("data-position", end!);
  await expect(page.locator("#exportJson")).toBeEnabled();
  await page.locator("#journeyReplay").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "source");
  await expect(journey(page)).toHaveAttribute("data-playback", "reduced-motion");
  await page.locator("#journeyPlay").press("Enter");
  await expect(journey(page)).not.toHaveAttribute("data-stage", "source");
  await expect(journey(page)).toHaveAttribute("data-playback", "reduced-motion");
  // Toggling the system setting mid-session must not discard genuine artifacts.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(journey(page)).toHaveAttribute("data-reduced-motion", "false");
  await expect(available(page, "dimensions")).toBeEnabled();
});

test("narrow touch controls remain reachable without horizontal page overflow", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Use the real touch-capable mobile context");
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await ready(page);
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 740 });
    await page.locator("#journey-root").scrollIntoViewIfNeeded();
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
    for (const id of ["journeyPlay", "journeyReplay", "journeySkip", "analyze", "toggleEditor"]) {
      const control = page.locator(`#${id}`);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height, `${id} touch target height`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${id} touch target width`).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
    await page.locator("#journeyReplay").tap();
    await expect(journey(page)).toHaveAttribute("data-playback", "playing");
    await page.locator("#journeyPlay").tap();
    await expect(journey(page)).toHaveAttribute("data-playback", "paused");
    await page.locator("#journeySkip").tap();
    await expect(journey(page)).toHaveAttribute("data-stage", "rectify");
  }
  await page.locator("#toggleEditor").tap();
  await expect(page.locator("#editorSurface")).toBeVisible();
  await expect(journey(page)).toHaveAttribute("data-playback", "editing");
  await page.screenshot({ path: info.outputPath("continuous-touch-320-393.png"), fullPage: true });
});

test("a whole-photo half turn stays projective and aligned through the moving midpoint", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "One real rotated-photo midpoint regression; normal/mobile endpoints run above");
  await page.goto("/");
  await ready(page);
  const bytes = await page.evaluate(async () => {
    const image = new Image(); image.src = new URL("samples/l-shape.png", document.baseURI).href; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!; context.translate(canvas.width, canvas.height); context.rotate(Math.PI); context.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#file").setInputFiles({ name: "real-sample-rotated-180.png", mimeType: "image/png", buffer: Buffer.from(bytes, "base64") });
  await ready(page);
  const report = await downloadJSON<DiagnosticReport>(page, "#debugExport");
  expect(stage(report, "markers").details.missing_ids).toEqual([]);
  expect(stage(report, "markers").details.selected.map((marker: any) => marker.id)).toEqual([0, 1, 2, 3]);
  await selectStage(page, "crop");
  const crop = await expectPlaneMapping(page);
  // This genuine fixture exposes the precision regression: its native-pixel
  // perspective coefficient was serialized from -4.1582e-6 to -4.1e-6,
  // moving the painted far corner by 0.185px on Chromium in CI. A conditioned
  // CSS domain must preserve the strict 0.05px probe/bounds checks above.
  expect(Math.abs(crop.matrix[6])).toBeGreaterThan(0);
  expect(Math.abs(crop.matrix[6])).toBeLessThan(1e-5);
  expect(crop.cssMatrix[6]).toBeCloseTo(crop.matrix[6] * crop.width / crop.cssWidth, 12);
  expect(crop.cssMatrix[7]).toBeCloseTo(crop.matrix[7] * crop.height / crop.cssHeight, 12);
  await page.locator("#journeyPlay").click();
  await page.waitForFunction(() => {
    const value = Number(document.querySelector<HTMLElement>("#journey-root")!.dataset.position);
    return value > 2.35 && value < 2.7;
  });
  await page.locator("#journeyPlay").click();
  await expect(journey(page)).toHaveAttribute("data-playback", "paused");
  const midpoint = Number(await journey(page).getAttribute("data-position"));
  expect(midpoint).toBeGreaterThan(2);
  expect(midpoint).toBeLessThan(3);
  const projection = await expectPlaneMapping(page);
  expect(polygonArea(projection.corners)).toBeGreaterThan(1_000);
  await journey(page).screenshot({ path: info.outputPath("journey-rotated-projective-midpoint.png") });
  await page.locator("#journeyPlay").click();
  await expect.poll(async () => Number(await journey(page).getAttribute("data-position"))).toBe(3);
  await expect(journey(page)).not.toHaveAttribute("data-playback", "fallback");
  await page.locator("#journeySkip").click();
  await expectPlaneMapping(page);
  await expectRectifiedPixels(page);
  await journey(page).screenshot({ path: info.outputPath("journey-rotated-settled-real-image.png") });
});

test("all decoded IDs with an individually rotated marker still cannot reveal a crop", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Calibration-orientation validation once using the genuine print fixture");
  await page.goto("/");
  await ready(page);
  const bytes = await page.evaluate(async () => {
    const image = new Image(); image.src = new URL("print/a4-marker-sheet.png", document.baseURI).href; await image.decode();
    const geometry = await (await fetch(new URL("print/geometry.json", document.baseURI))).json();
    const scale = image.naturalWidth / geometry.page_mm[0];
    const [xMm, yMm] = geometry.marker_corners_page_mm[0][0];
    const x = Math.round(xMm * scale), y = Math.round(yMm * scale), size = Math.round(geometry.marker_side_mm * scale);
    const marker = document.createElement("canvas"); marker.width = marker.height = size;
    const patch = marker.getContext("2d")!; patch.translate(size, size); patch.rotate(Math.PI);
    patch.drawImage(image, x, y, size, size, 0, 0, size, size);
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0); context.drawImage(marker, x, y);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#file").setInputFiles({ name: "real-board-one-marker-rotated.png", mimeType: "image/png", buffer: Buffer.from(bytes, "base64") });
  await startLegacyCalibration(page);
  await expect(page.locator("#status")).toContainText("マーカーの向きが規定と違います");
  await expect(journey(page)).toHaveAttribute("data-processing", "error");
  const report = await downloadJSON<DiagnosticReport>(page, "#debugExport");
  const marker = stage(report, "markers");
  expect(marker.details.selected.map((item: any) => item.id)).toEqual([0, 1, 2, 3]);
  expect(marker.details.missing_ids).toEqual([]);
  expect(report.stages.map((entry) => entry.id)).toEqual(["input", "markers"]);
  await expect(available(page, "crop")).toHaveCount(0);
  await expect(available(page, "rectify")).toHaveCount(0);
  await noAnalysis(page);
  await page.locator("#journeySkip").click();
  await expect(journey(page)).toHaveAttribute("data-stage", "markers");
  await expect(page.locator("#runB")).toBeDisabled();
  await journey(page).screenshot({ path: info.outputPath("journey-invalid-orientation-no-crop.png") });
});
