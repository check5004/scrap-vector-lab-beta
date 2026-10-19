import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

const routes = [
  { button: "upload", input: "file", name: "写真ライブラリ・ファイルから選ぶ" },
  { button: "camera", input: "cameraFile", name: "カメラで撮影" },
];
const ready = async (page: Page) => {
  await expect(page.locator("#status")).toContainText("平面補正できました", { timeout: 30000 });
  await expect(page.locator("#upload")).toBeEnabled();
};
const controlsEnabled = async (page: Page) => {
  for (const selector of ["#upload", "#camera", "#file", "#cameraFile"])
    await expect(page.locator(selector)).toBeEnabled();
};

test.beforeEach(async ({ page }) => {
  // No API calls are needed for photo import, decoding or marker detection.
  await page.goto("/");
  await ready(page);
});

test("library and camera have distinct accessible controls and picker attributes", async ({ page }) => {
  await expect(page.locator("#file")).toHaveAttribute("type", "file");
  await expect(page.locator("#file")).toHaveAttribute("accept", "image/*");
  await expect(page.locator("#file")).not.toHaveAttribute("capture", /.*/);
  await expect(page.locator("#cameraFile")).toHaveAttribute("type", "file");
  await expect(page.locator("#cameraFile")).toHaveAttribute("accept", "image/*");
  await expect(page.locator("#cameraFile")).toHaveAttribute("capture", "environment");
  const sourceBefore = await page.locator("#sourceLabel").textContent();
  const markersBefore = await page.locator("#markerLabel").textContent();
  for (const route of routes) {
    const button = page.getByRole("button", { name: route.name });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("aria-controls", route.input);
    await button.focus();
    const pending = page.waitForEvent("filechooser");
    await button.press(route.button === "upload" ? "Enter" : "Space");
    const chooser = await pending;
    expect(await chooser.element().getAttribute("id")).toBe(route.input);
    // Empty selection exercises the no-file path; native picker cancellation
    // remains part of the manual iPhone checklist.
    await chooser.setFiles([]);
    await ready(page);
    await expect(page.locator("#sourceLabel")).toHaveText(sourceBefore!);
    await expect(page.locator("#markerLabel")).toHaveText(markersBefore!);
    await expect(page.locator("#runB")).toBeEnabled();
  }
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
});

for (const route of routes) {
  test(`${route.input} imports a real marker image, locks both routes, and permits same-file retry`, async ({ page }) => {
    const remote: string[] = [];
    const origin = new URL(page.url()).origin;
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin)
        remote.push(request.url());
    });
    await page.locator("#debugStep").check();
    const pending = page.waitForEvent("filechooser");
    await page.locator(`#${route.button}`).click();
    const chooser = await pending;
    await chooser.setFiles(resolve("public/samples/l-shape.png"));
    await expect(page.locator("#debugActivity")).toContainText("入力写真で停止中");
    for (const selector of ["#upload", "#camera", "#file", "#cameraFile"])
      await expect(page.locator(selector)).toBeDisabled();
    await expect(page.locator(`#${route.input}`)).toHaveValue("");
    await page.locator("#debugContinue").click();
    await ready(page);
    await controlsEnabled(page);
    await expect(page.locator("#sourceLabel")).toHaveText("l-shape.png");
    await expect(page.locator("#markerLabel")).toContainText("0 · 1 · 2 · 3");
    await expect(page.locator("#runB")).toBeEnabled();
    // A second selection of the identical file must run again.
    await page.locator("#debugStep").check();
    await page.locator(`#${route.input}`).setInputFiles(resolve("public/samples/l-shape.png"));
    await expect(page.locator("#debugActivity")).toContainText("入力写真で停止中");
    await page.locator("#debugCancel").click();
    await expect(page.locator("#status")).toContainText("中止");
    await controlsEnabled(page);
    await expect(page.locator("#runB")).toBeDisabled();
    // Cancellation must also allow the identical file to be selected again.
    await page.locator(`#${route.input}`).setInputFiles(resolve("public/samples/l-shape.png"));
    await expect(page.locator("#debugActivity")).toContainText("入力写真で停止中");
    await page.locator("#debugContinue").click();
    await ready(page);
    // This observes cross-origin requests; it is not a claim about every network operation.
    expect(remote).toEqual([]);
  });

  test(`${route.input} retains size validation and releases controls after rejection`, async ({ page }) => {
    await page.evaluate((inputId) => {
      const input = document.getElementById(inputId) as HTMLInputElement;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(30 * 1024 * 1024 + 1)], "too-large.jpg", { type: "image/jpeg" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, route.input);
    await expect(page.locator("#status")).toContainText("30 MB以下");
    await controlsEnabled(page);
    await expect(page.locator(`#${route.input}`)).toHaveValue("");
  });

  test(`${route.input} explains HEIC decode failures without claiming all HEIC is unsupported`, async ({ page }) => {
    await page.evaluate(() => {
      const tracker = { created: [] as string[], revoked: [] as string[] };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { const url = create(blob); tracker.created.push(url); return url; };
      URL.revokeObjectURL = (url) => { tracker.revoked.push(url); revoke(url); };
      (window as any).__photoUrls = tracker;
    });
    // Deliberately corrupt bytes exercise decode failure, not real HEIC support.
    // One route identifies HEIC by extension; the other by MIME type.
    const corrupt = {
      name: route.input === "file" ? "IMG_0001.HEIC" : "image-from-camera",
      mimeType: route.input === "file" ? "" : "image/heif",
      buffer: Buffer.from("deliberately invalid image fixture"),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.locator(`#${route.input}`).setInputFiles(corrupt);
      await expect(page.locator("#status")).toContainText("HEIC/HEIF画像を読み込めません");
      await expect(page.locator("#status")).toContainText("未対応か、ファイルが壊れている可能性");
      await expect(page.locator("#status")).toContainText("JPEGまたはPNGに変換した画像");
      await controlsEnabled(page);
      await expect(page.locator(`#${route.input}`)).toHaveValue("");
      await expect(page.locator("#runB")).toBeDisabled();
      await expect(page.locator("#exportJson")).toBeDisabled();
    }
    const tracker = await page.evaluate(() => (window as any).__photoUrls);
    expect(tracker.created).toHaveLength(2);
    expect(tracker.revoked).toEqual(tracker.created);
    await page.locator(`#${route.input}`).setInputFiles({
      name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("invalid jpeg"),
    });
    await expect(page.locator("#status")).toContainText("このブラウザで表示できる画像");
    await expect(page.locator("#status")).not.toContainText("HEIC/HEIF");
    await controlsEnabled(page);
  });
}

// Add a real EXIF APP1 tag to a browser-encoded JPEG; no image library/dependency.
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  const app1 = Buffer.from("ffe1002245786966000049492a0008000000010012010300010000000100000000000000", "hex");
  app1.writeUInt16LE(orientation, 28);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

test("real JPEG EXIF orientations survive the shared decode-to-canvas pipeline exactly once", async ({ page }) => {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80; canvas.height = 40;
    const ctx = canvas.getContext("2d")!;
    for (const [i, color] of ["#ff0000", "#00ff00", "#0000ff", "#ffff00"].entries()) {
      ctx.fillStyle = color;
      ctx.fillRect((i % 2) * 40, Math.floor(i / 2) * 20, 40, 20);
    }
    return canvas.toDataURL("image/jpeg", 1).split(",")[1];
  });
  await page.locator("#toggleEditor").click();
  const jpeg = Buffer.from(encoded, "base64");
  // Expected displayed corners in this list are TL, TR, BL, BR.
  const corners = [
    ["R", "G", "B", "Y"], ["G", "R", "Y", "B"],
    ["Y", "B", "G", "R"], ["B", "Y", "R", "G"],
    ["R", "B", "G", "Y"], ["B", "R", "Y", "G"],
    ["Y", "G", "B", "R"], ["G", "Y", "R", "B"],
  ];
  const palette: Record<string, number[]> = { R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255], Y: [255, 255, 0] };
  for (let orientation = 1; orientation <= 8; orientation++) {
    const route = routes[orientation % 2];
    await page.locator(`#${route.input}`).setInputFiles({
      name: `exif-${orientation}.jpg`, mimeType: "image/jpeg",
      buffer: withExifOrientation(jpeg, orientation),
    });
    await expect(page.locator("#sourceLabel")).toHaveText(`exif-${orientation}.jpg`);
    // Featureless color quadrants intentionally have no ArUco board.
    await expect(page.locator("#status")).toContainText("見つかりません");
    await controlsEnabled(page);
    await page.locator("#view").selectOption("photo");
    const size = orientation <= 4 ? [80, 40] : [40, 80];
    await expect(page.locator("#editor")).toHaveAttribute("viewBox", `0 0 ${size.join(" ")}`);
    const pixels = await page.evaluate(async () => {
      const href = document.querySelector("#editor image")!.getAttribute("href")!;
      const image = new Image(); image.src = href; await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
      return [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) =>
        Array.from(ctx.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data).slice(0, 3));
    });
    corners[orientation - 1].forEach((color, corner) => {
      palette[color].forEach((channel, index) => expect(Math.abs(pixels[corner][index] - channel)).toBeLessThan(20));
    });
  }
});
