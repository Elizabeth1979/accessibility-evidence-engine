import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import type {
  AxeTargetBox,
  FindingInstanceSynthesis,
  FindingSynthesis,
  ScenarioIntegratedReport
} from "./scenario-runner";

/** A picture of one problem in the PR comment. */
export interface CommentImage {
  url: string;
  alt: string;
}

/** The page around an element, in CSS pixels, so a crop shows where the element sits. */
const CROP_MARGIN = 120;
/** The outline's width in CSS pixels and its colour, a magenta few page palettes use. */
const OUTLINE_WIDTH = 3;
const OUTLINE_RGB = [213, 0, 143] as const;
/** At most this many problems get a picture, so a comment stays quick to load. */
export const COMMENT_IMAGE_LIMIT = 10;

/**
 * The page around an element's box, cut from the screenshot the box was measured on, with the
 * element outlined just outside its edge. Nothing when the screenshot is not the page the box
 * describes, which a crop would then misplace, or when the element is the whole page, such as
 * for a missing heading, where an outline points at nothing.
 */
export function outlinedCrop(page: PNG, box: AxeTargetBox): Buffer | undefined {
  const scale = page.width / box.pageWidth;
  if (Math.abs(page.height - box.pageHeight * scale) > scale) return undefined;
  // The page's size is rounded to whole pixels; the element's is not.
  const wholePage =
    box.x <= 0 && box.y <= 0 && box.width >= box.pageWidth - 1 && box.height >= box.pageHeight - 1;
  if (wholePage) return undefined;
  const px = (value: number) => Math.round(value * scale);
  const outline = Math.max(1, px(OUTLINE_WIDTH));
  const element = {
    left: px(box.x) - outline,
    top: px(box.y) - outline,
    right: px(box.x + box.width) + outline,
    bottom: px(box.y + box.height) + outline
  };
  const left = Math.max(0, element.left - px(CROP_MARGIN));
  const top = Math.max(0, element.top - px(CROP_MARGIN));
  const right = Math.min(page.width, element.right + px(CROP_MARGIN));
  const bottom = Math.min(page.height, element.bottom + px(CROP_MARGIN));
  if (right <= left || bottom <= top) return undefined;
  const crop = new PNG({ width: right - left, height: bottom - top });
  PNG.bitblt(page, crop, left, top, crop.width, crop.height, 0, 0);
  for (
    let y = Math.max(0, element.top - top);
    y < Math.min(crop.height, element.bottom - top);
    y++
  ) {
    for (
      let x = Math.max(0, element.left - left);
      x < Math.min(crop.width, element.right - left);
      x++
    ) {
      const inside =
        x >= element.left - left + outline &&
        x < element.right - left - outline &&
        y >= element.top - top + outline &&
        y < element.bottom - top - outline;
      if (inside) continue;
      const index = (y * crop.width + x) * 4;
      crop.data.set([...OUTLINE_RGB, 255], index);
    }
  }
  return PNG.sync.write(crop);
}

/** Cuts elements from the screenshots they were measured on, reading each screenshot once. */
export function createElementCropper(): (
  screenshot: string,
  box: AxeTargetBox
) => Buffer | undefined {
  const pages = new Map<string, PNG>();
  return (screenshot, box) => {
    const page = pages.get(screenshot) ?? PNG.sync.read(readFileSync(screenshot));
    pages.set(screenshot, page);
    return outlinedCrop(page, box);
  };
}

/**
 * Pictures for a comment's problems, named by their content so a picture already uploaded is the
 * same file. `imageFor` is called as the comment is rendered, so only the problems it shows get a
 * picture; `files` then holds each picture to upload, by name.
 */
export function commentImages(
  reports: Array<{ report: ScenarioIntegratedReport; dir: string }>,
  urlFor: (name: string) => string
): {
  imageFor: (finding: FindingSynthesis) => CommentImage | undefined;
  files: Map<string, Buffer>;
} {
  // A suite comment merges findings across reports, but keeps each instance as it was found, so
  // the instance says which screenshot it was measured on: the one the report shows it on.
  const screenshots = new WeakMap<FindingInstanceSynthesis, string>();
  for (const { report, dir } of reports) {
    for (const finding of report.synthesis.findings) {
      const screenshot = finding.checkpoints[0]?.screenshotPath;
      if (!screenshot) continue;
      for (const instance of finding.instances) {
        screenshots.set(instance, path.resolve(dir, screenshot));
      }
    }
  }
  const crop = createElementCropper();
  const files = new Map<string, Buffer>();
  const imageFor = (finding: FindingSynthesis): CommentImage | undefined => {
    if (files.size >= COMMENT_IMAGE_LIMIT) return undefined;
    for (const instance of finding.instances) {
      const file = screenshots.get(instance);
      if (!file || !instance.targetBox) continue;
      const picture = crop(file, instance.targetBox);
      if (!picture) continue;
      const name = `${createHash("sha256").update(picture).digest("hex").slice(0, 32)}.png`;
      files.set(name, picture);
      return {
        url: urlFor(name),
        alt: `Screenshot: “${instance.label}” in ${instance.component}, outlined in pink`
      };
    }
    return undefined;
  };
  return { imageFor, files };
}
