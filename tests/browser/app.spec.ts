import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const ready = async (page: any) => {
  await expect(page.locator("#status")).toContainText("平面補正できました", {
    timeout: 30000,
  });
};
const infer = async (page: any) => {
  await page.locator("#runB").click();
  await expect(page.locator("#status")).toContainText(
    "実際のU²-NetP推論が完了",
    { timeout: 150000 },
  );
};
test("real marker detection, ONNX inference, edits, export, no paid requests", async ({
  page,
}, info) => {
  const errors: string[] = [];
  const remote: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https:\/\/(api\.openai\.com|openrouter\.ai)\//.test(r.url()))
      remote.push(r.url());
  });
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#runA")).toBeDisabled();
  await expect(page.locator("#markerLabel")).toContainText("0 · 1 · 2 · 3");
  await infer(page);
  const area = Number(
    (await page.locator("#area").innerText()).replaceAll(",", ""),
  );
  expect(area).toBeGreaterThan(10000);
  expect(area).toBeLessThan(15500);
  await expect(page.locator("#benchmark")).toContainText(
    "MODE B · 境界平均誤差",
  );
  await page.locator("#editC").click();
  await expect(page.locator("[data-pin]").first()).toBeVisible();
  const initial = await page.locator("#vertices").innerText();
  // The line target is the actual overlay edge, not injected inference data.
  await page.locator("#editor").scrollIntoViewIfNeeded();
  const edgeBox = await page.locator("[data-edge]").first().boundingBox();
  if (!edgeBox) throw Error("No visible editable edge");
  await page.mouse.click(
    edgeBox.x + edgeBox.width / 2,
    edgeBox.y + edgeBox.height / 2,
  );
  expect(Number(await page.locator("#vertices").innerText())).toBe(
    Number(initial) + 1,
  );
  await page.locator("#delete").click();
  await expect(page.locator("#vertices")).toHaveText(initial);
  await page.locator("#undo").click();
  expect(Number(await page.locator("#vertices").innerText())).toBe(
    Number(initial) + 1,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportJson").click();
  const download = await downloadPromise;
  const data = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(data.units).toBe("mm");
  expect(data.provenance.method).toBe("human-edited");
  expect(data.board_size_mm.width_mm).toBe(250);
  expect(data.total_area_mm2).toBeGreaterThan(10000);
  expect(remote).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("working-app.png"),
    fullPage: true,
  });
  if (info.project.name === "mobile") {
    const dimensions = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
  }
});
test("real three-sample benchmark preserves and reports model failure on a hole", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Full three-sample benchmark once on desktop",
  );
  await page.goto("/");
  await ready(page);
  for (const sample of ["l-shape", "notched", "trapezoid-hole"]) {
    if (sample !== "l-shape") {
      await page.locator(`[data-sample="${sample}"]`).click();
      await ready(page);
    }
    await infer(page);
    await expect(page.locator("#area")).not.toHaveText("—");
    if (sample === "trapezoid-hole") {
      await expect(page.locator("#benchmark")).toContainText("正解 1");
      await expect(page.locator("#warnings")).toContainText("穴");
      await page.locator("#editC").click();
      await page.locator("#drawHole").click();
      await page.locator("#editor").scrollIntoViewIfNeeded();
      const points = await page.locator("#editor").evaluate((svg: any) => {
        const matrix = svg.getScreenCTM();
        return [
          [105, 86],
          [125, 66],
          [145, 86],
          [125, 106],
        ].map(([x, y]) => {
          const p = new DOMPoint(x, y).matrixTransform(matrix);
          return { x: p.x, y: p.y };
        });
      });
      for (const p of points) await page.mouse.click(p.x, p.y);
      await page.locator("#finishDraw").click();
      await expect(page.locator("#holes")).toHaveText("1");
      await page.locator("#undo").click();
      await expect(page.locator("#holes")).toHaveText("0");
    }
  }
});
test("missing marker fails closed, custom board rescales, invalid key stays out of storage", async ({
  page,
}, info) => {
  await page.goto("/");
  await ready(page);
  await page.locator("#preset").selectOption("custom");
  await page.locator("#width").fill("2000");
  await page.locator("#height").fill("1000");
  await page.locator("#rectify").click();
  await ready(page);
  await expect(page.locator("#scale")).toContainText("2000 × 1000");
  await page.locator("summary").filter({ hasText: "A · GPT-6 Luna" }).click();
  await page.locator("#apiKey").fill("test-not-a-real-key");
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).length + Object.keys(sessionStorage).length,
    ),
  ).toBe(0);
  await page.locator("#clearKey").click();
  await expect(page.locator("#apiKey")).toHaveValue("");
  // A featureless real image input must not be converted into a guessed board.
  await page.locator("#file").setInputFiles({
    name: "no-markers.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="white"/></svg>',
    ),
  });
  await expect(page.locator("#status")).toContainText("見つかりません");
  await expect(page.locator("#runB")).toBeDisabled();
  await expect(page.locator("#debugDetails")).toContainText("missing_ids");
  await expect(page.locator("#debugImage")).toBeVisible();
});

test("visible real processing stages can pause, advance, cancel and export safe diagnostics", async ({
  page,
}, info) => {
  await page.goto("/");
  await ready(page);
  await page.locator("#debugStep").check();
  await page.locator("#debugRun").click();
  await expect(page.locator("#debugActivity")).toContainText(
    "入力写真で停止中",
  );
  await expect(page.locator("#debugNext")).toBeEnabled();
  await expect(page.locator('[data-stage="markers"]')).toBeDisabled();
  if (info.project.name === "mobile") {
    await page.locator("#debugCancel").click();
    await expect(page.locator("#status")).toContainText("中止");
    await expect(page.locator("#runB")).toBeDisabled();
    await expect(page.locator("#debugNext")).toBeDisabled();
    return;
  }
  await page.locator("#debugNext").click();
  await expect(page.locator("#debugActivity")).toContainText(
    "ArUco検出・候補で停止中",
  );
  await expect(page.locator("#debugDetails")).toContainText(
    "rejected_candidates",
  );
  await expect(page.locator("#debugDetails")).toContainText("missing_ids");
  await expect(page.locator('[data-stage="rectified"]')).toBeDisabled();
  await page.locator("#debugNext").click();
  await expect(page.locator("#debugActivity")).toContainText(
    "射影変換後の実画像で停止中",
  );
  await expect(page.locator("#debugDetails")).toContainText(
    "source_to_rectified_h",
  );
  await page.locator("#debugNext").click();
  await expect(page.locator("#debugActivity")).toContainText(
    "方眼付き画像で停止中",
  );
  await expect(page.locator('[data-stage="probability"]')).toBeDisabled();
  await page.locator("#debugNext").click();
  await expect(page.locator("#debugActivity")).toContainText(
    "実ニューラル推論の確率画像で停止中",
    { timeout: 150000 },
  );
  await expect(page.locator("#debugDetails")).toContainText("timings_ms");
  await expect(page.locator('[data-stage="binary"]')).toBeDisabled();
  await page.locator("#debugNext").click();
  await expect(page.locator("#debugActivity")).toContainText("2値化で停止中");
  await expect(page.locator('[data-stage="contours"]')).toBeDisabled();
  await page.locator("#debugNext").click();
  await expect(page.locator("#debugActivity")).toContainText(
    "生の輪郭で停止中",
  );
  await expect(page.locator('[data-stage="polygon"]')).toBeDisabled();
  await page.locator("#debugNext").click();
  await expect(page.locator("#debugActivity")).toContainText("実寸で停止中");
  await expect(page.locator("#exportJson")).toBeDisabled();
  await page.locator("#debugNext").click();
  await expect(page.locator("#status")).toContainText(
    "実際のU²-NetP推論が完了",
  );
  await expect(page.locator("#exportJson")).toBeEnabled();
  const pending = page.waitForEvent("download");
  await page.locator("#debugExport").click();
  const downloaded = await pending,
    report = JSON.parse(await readFile((await downloaded.path())!, "utf8"));
  expect(report.stages.map((s: any) => s.id)).toEqual([
    "input",
    "markers",
    "rectified",
    "grid",
    "probability",
    "binary",
    "contours",
    "polygon",
  ]);
  expect(report.stages.every((s: any) => !("image" in s))).toBeTruthy();
  const marker = report.stages.find((s: any) => s.id === "markers");
  expect(marker.details.missing_ids).toEqual([]);
  expect(marker.details.selected.map((m: any) => m.id)).toEqual([0, 1, 2, 3]);
  expect(marker.elapsedMs).toBeGreaterThan(0);
  const neural = report.stages.find((s: any) => s.id === "probability");
  expect(neural.details.timings_ms.inference).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toContain("data:image");
  await page.screenshot({
    path: info.outputPath("real-debug-stages.png"),
    fullPage: true,
  });
  // Repeat a genuine inference, cancel after its real output, and ensure no orphan mask can export.
  await page.locator("#runB").click();
  await expect(page.locator("#debugActivity")).toContainText(
    "実ニューラル推論の確率画像で停止中",
    { timeout: 150000 },
  );
  await page.locator("#debugCancel").click();
  await expect(page.locator("#status")).toContainText("中止");
  await page.locator("#epsilon").press("ArrowRight");
  await expect(page.locator("#area")).toHaveText("—");
  await expect(page.locator("#exportJson")).toBeDisabled();
  await page.locator("#runB").click();
  await expect(page.locator("#debugActivity")).toContainText(
    "実ニューラル推論の確率画像で停止中",
    { timeout: 150000 },
  );
  await page.locator("#debugContinue").click();
  await expect(page.locator("#status")).toContainText(
    "実際のU²-NetP推論が完了",
  );
  await expect(page.locator("#exportJson")).toBeEnabled();
});

test("three AI-texture composite samples use genuine marker detection and neural inference", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Additional three-fixture inference suite runs on desktop",
  );
  await page.goto("/");
  await ready(page);
  for (const sample of ["ai-l-shape", "ai-notched", "ai-trapezoid-hole"]) {
    await page.locator(`[data-sample="${sample}"]`).click();
    await ready(page);
    await expect(page.locator("#sourceLabel")).toContainText(
      "AI質感＋寸法管理",
    );
    await expect(page.locator("#markerLabel")).toContainText("0 · 1 · 2 · 3");
    await infer(page);
    const area = Number(
      (await page.locator("#area").innerText()).replaceAll(",", ""),
    );
    expect(area).toBeGreaterThan(5000);
    expect(area).toBeLessThan(30000);
    await expect(page.locator("#benchmark")).toContainText(
      "MODE B · 境界平均誤差",
    );
    await page.locator('[data-stage="probability"]').click();
    await expect(page.locator("#debugDetails")).toContainText("U2NetP");
    await page.screenshot({
      path: info.outputPath(`${sample}.png`),
      fullPage: true,
    });
  }
});

test("provider routing blocks wrong keys locally and shows a mocked 401 without leaking response text", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (/^https:\/\/(api\.openai\.com|openrouter\.ai)\//.test(r.url()))
      remote.push(r.url());
  });
  // Test-only interception. These are deliberate fixtures, not a live API or inference test.
  await page.route("https://openrouter.ai/**", (route) => route.abort());
  await page.route("https://openrouter.ai/api/v1/key", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          message: "PRIVATE_BODY_MUST_NOT_APPEAR sk-or-v1-test-only",
          code: 401,
        },
      }),
    }),
  );
  await page.route("https://api.openai.com/**", (route) => route.abort());
  await page.goto("/");
  await ready(page);
  await page.locator("summary").filter({ hasText: "A · GPT-6 Luna" }).click();
  await expect(page.locator("#provider")).toHaveValue("openrouter");
  await page.locator("#apiKey").fill("sk-proj-test-only");
  await page.locator("#consent").check();
  await expect(page.locator("#runA")).toBeDisabled();
  await expect(page.locator("#keyValidation")).toContainText(
    "別サービスのキーは送信しません",
  );
  expect(remote).toEqual([]);
  await page.locator("#provider").selectOption("openai");
  await expect(page.locator("#apiKey")).toHaveValue("");
  await expect(page.locator("#consent")).not.toBeChecked();
  await page.locator("#apiKey").fill("sk-or-v1-test-only");
  await page.locator("#consent").check();
  await expect(page.locator("#runA")).toBeDisabled();
  await expect(page.locator("#keyValidation")).toContainText(
    "OpenRouterのキーはOpenAIに送信できません",
  );
  expect(remote).toEqual([]);
  await page.locator("#provider").selectOption("openrouter");
  await page.locator("#apiKey").fill("sk-or-v1-test-only");
  await page.locator("#consent").check();
  await page.locator("#runA").click();
  await expect(page.locator("#status")).toContainText("HTTP 401");
  await expect(page.locator("#status")).toContainText("原因を断定できません");
  await expect(page.locator("#debugDetails")).toContainText(
    "https://openrouter.ai/api/v1/key",
  );
  await expect(page.locator("#debugDetails")).toContainText("HTTP_401");
  await expect(page.locator("body")).not.toContainText(
    "PRIVATE_BODY_MUST_NOT_APPEAR",
  );
  expect(remote).toEqual(["https://openrouter.ai/api/v1/key"]);
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).length + Object.keys(sessionStorage).length,
    ),
  ).toBe(1); // Only the validated, provider-scoped local key record is persisted.
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  const pending = page.waitForEvent("download");
  await page.locator("#debugExport").click();
  const downloaded = await pending,
    report = await readFile((await downloaded.path())!, "utf8");
  expect(report).not.toContain("sk-or-v1-test-only");
  expect(report).not.toContain("PRIVATE_BODY_MUST_NOT_APPEAR");
});
