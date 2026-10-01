import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PNG } from "pngjs";

import { COMMENT_IMAGE_LIMIT, commentImages, elementCrop, MODEL_CROP } from "./comment-images";
import type { ScenarioIntegratedReport } from "./scenario-runner";

/** A white page of the given size, as a screenshot at twice its CSS pixels. */
function whitePage(width: number, height: number): PNG {
  const page = new PNG({ width: width * 2, height: height * 2 });
  page.data.fill(255);
  return page;
}

const pixel = (png: PNG, x: number, y: number) => [
  ...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)
];

test("a crop shows the page around the element, outlined just outside its edge", () => {
  const box = { x: 200, y: 150, width: 40, height: 20, pageWidth: 600, pageHeight: 400 };
  const crop = PNG.sync.read(elementCrop(whitePage(600, 400), box)!);

  // 120 CSS pixels each side of the 3-pixel outline, at the screenshot's scale of 2.
  assert.deepEqual([crop.width, crop.height], [(40 + 2 * 123) * 2, (20 + 2 * 123) * 2]);
  const outlineStart = 120 * 2;
  assert.deepEqual(pixel(crop, outlineStart, outlineStart), [213, 0, 143, 255]);
  assert.deepEqual(pixel(crop, outlineStart + 5, outlineStart + 5), [213, 0, 143, 255]);
  // The element itself and the page around the outline are as they were.
  assert.deepEqual(pixel(crop, outlineStart + 6, outlineStart + 6), [255, 255, 255, 255]);
  assert.deepEqual(pixel(crop, outlineStart - 1, outlineStart - 1), [255, 255, 255, 255]);
});

test("a crop at the page's edge stops at it, and a box from another page or the whole page gives none", () => {
  const corner = { x: 0, y: 0, width: 50, height: 10, pageWidth: 600, pageHeight: 400 };
  const crop = PNG.sync.read(elementCrop(whitePage(600, 400), corner)!);
  assert.deepEqual([crop.width, crop.height], [(50 + 3 + 120) * 2, (10 + 3 + 120) * 2]);

  // Measured on a page 900 pixels tall, so this screenshot is not the page the box describes.
  assert.equal(elementCrop(whitePage(600, 400), { ...corner, pageHeight: 900 }), undefined);
  // The whole page, as for a missing heading, has nothing to point at. The page's height is
  // rounded; the element's, as the browser measured it, is not.
  const page = { x: 0, y: 0, width: 600, height: 399.55, pageWidth: 600, pageHeight: 400 };
  assert.equal(elementCrop(whitePage(600, 400), page), undefined);
});

test("a model's crop is the element itself, cut close to its edges with no outline", () => {
  const box = { x: 200, y: 150, width: 40, height: 20, pageWidth: 600, pageHeight: 400 };
  const crop = PNG.sync.read(elementCrop(whitePage(600, 400), box, MODEL_CROP)!);

  assert.deepEqual([crop.width, crop.height], [(40 + 2 * 8) * 2, (20 + 2 * 8) * 2]);
  assert.deepEqual(pixel(crop, 8 * 2 - 1, 8 * 2 - 1), [255, 255, 255, 255]);
});

test("a comment's pictures come from the screenshot each element was measured on", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aee-comment-images-"));
  try {
    await mkdir(path.join(dir, "artifacts"));
    await writeFile(path.join(dir, "artifacts", "page.png"), PNG.sync.write(whitePage(600, 400)));
    const instance = (index: number) => ({
      component: "Password toggle",
      label: `Show ${index}`,
      selector: `#toggle-${index}`,
      targetBox: { x: 20, y: 10, width: 10 + index, height: 10, pageWidth: 600, pageHeight: 400 }
    });
    const findings = Array.from({ length: COMMENT_IMAGE_LIMIT + 2 }, (_, index) => ({
      instances: [instance(index)],
      checkpoints: [{ screenshotPath: "artifacts/page.png" }]
    }));
    const report = { synthesis: { findings } } as unknown as ScenarioIntegratedReport;
    const { imageFor, files } = commentImages([{ report, dir }], (name) => `https://pics/${name}`);

    const first = imageFor(findings[0] as never);
    assert.match(first!.url, /^https:\/\/pics\/[0-9a-f]{32}\.png$/);
    assert.equal(first!.alt, "Screenshot: “Show 0” in Password toggle, outlined in pink");
    // The same picture again is the same file.
    assert.deepEqual(imageFor(findings[0] as never), first);
    assert.equal(files.size, 1);
    // An element no report measured has nothing to show.
    assert.equal(imageFor({ instances: [instance(99)] } as never), undefined);
    // Past the limit, a problem gets no picture.
    for (const finding of findings) imageFor(finding as never);
    assert.equal(files.size, COMMENT_IMAGE_LIMIT);
    assert.equal(imageFor(findings.at(-1) as never), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
