import { PNG } from "pngjs";

import type { ElementLocationPage } from "./element-locations";

/**
 * Why axe could not decide a text's contrast, for the reasons the pixels behind the text can
 * settle: a background image, a gradient, or an image element under the text. Another element
 * overlapping the text (`bgOverlap`) is not one of them, since it may cover the text itself.
 */
const MEASURABLE_REASONS = new Set(["bgImage", "bgGradient", "imgNode"]);
/** At most this many texts are measured at one checkpoint; the rest stay for a person. */
const MAXIMUM_MEASURED = 40;
const PROBE_ATTRIBUTE = "data-aee-contrast-probe";

/** A color behind the text and the contrast the text has against it. */
export interface ContrastExtreme {
  ratio: number;
  background: string;
}

/**
 * The text's contrast against every pixel behind it, taken from a screenshot with the text hidden.
 * It passes when every pixel gives the required ratio and fails when none does; when some do and
 * some do not, it stays undecided. A text the screenshot cannot answer for says why.
 */
export type ContrastMeasurement =
  MeasuredContrast | { verdict: "unmeasured"; requiredRatio: number; reason: string };

export interface MeasuredContrast {
  verdict: "pass" | "fail" | "undecided";
  requiredRatio: number;
  foreground: string;
  lowest: ContrastExtreme;
  highest: ContrastExtreme;
}

export interface ContrastMeasuringPage extends ElementLocationPage {
  screenshot(options: {
    type: "png";
    fullPage: true;
    scale: "css";
    animations: "disabled";
    caret: "hide";
    timeout: number;
  }): Promise<unknown>;
}

interface AxeNodeLike {
  target: unknown[];
  any?: Array<{ message?: string; data?: unknown }>;
  failureSummary?: string;
}

interface AxeRuleLike<Node extends AxeNodeLike> {
  id: string;
  nodes: Node[];
}

interface AxeResultLike<Node extends AxeNodeLike> {
  violations: Array<AxeRuleLike<Node>>;
  passes: Array<AxeRuleLike<Node>>;
  incomplete: Array<AxeRuleLike<Node>>;
}

/** What the page says about one text: its color and where its lines are, or why it cannot say. */
type TextProbe =
  { foreground: [number, number, number, number]; rects: DOMRectInit[] } | { unmeasured: string };

/**
 * Settles the `color-contrast` checks axe left incomplete because of what is behind the text.
 * Each text it decides moves to the rule's passes or violations, with its measurement attached as
 * `aeeContrast` and, when it fails, the measured colors in axe's own wording. Every other check,
 * and every text it cannot decide, stays exactly as axe reported it.
 */
export async function settleContrastByPixels<
  Node extends AxeNodeLike,
  Result extends AxeResultLike<Node>
>(page: ContrastMeasuringPage, result: Result): Promise<Result> {
  const rule = result.incomplete.find(({ id }) => id === "color-contrast");
  const candidates = (rule?.nodes ?? [])
    .map((node) => ({ node, selector: singleSelector(node), check: contrastCheck(node) }))
    .filter(
      (candidate): candidate is { node: Node; selector: string; check: ContrastCheck } =>
        Boolean(candidate.selector) && MEASURABLE_REASONS.has(candidate.check.reason)
    )
    .slice(0, MAXIMUM_MEASURED);
  if (!rule || candidates.length === 0) return result;

  const measurements = await measureTexts(
    page,
    candidates.map(({ selector, check }) => ({ selector, requiredRatio: check.requiredRatio }))
  );
  if (!measurements) return result;

  const decided = new Map<Node, { node: Node; verdict: "pass" | "fail" }>();
  const measuredNodes = new Map<Node, Node>();
  candidates.forEach(({ node }, index) => {
    const measurement = measurements[index]!;
    const annotated = { ...node, aeeContrast: measurement };
    if (measurement.verdict === "pass" || measurement.verdict === "fail") {
      decided.set(node, {
        node:
          measurement.verdict === "fail" ? withMeasuredFailure(annotated, measurement) : annotated,
        verdict: measurement.verdict
      });
    } else {
      measuredNodes.set(node, annotated);
    }
  });
  const moved = (verdict: "pass" | "fail") =>
    [...decided.values()].filter((entry) => entry.verdict === verdict).map(({ node }) => node);
  const remaining = rule.nodes
    .filter((node) => !decided.has(node))
    .map((node) => measuredNodes.get(node) ?? node);
  return {
    ...result,
    incomplete: result.incomplete.flatMap((entry) =>
      entry !== rule ? [entry] : remaining.length ? [{ ...rule, nodes: remaining }] : []
    ),
    violations: withNodes(result.violations, rule, moved("fail")),
    passes: withNodes(result.passes, rule, moved("pass"))
  };
}

interface ContrastCheck {
  reason: string;
  requiredRatio: number;
}

/** Why axe could not decide, and the ratio it required: 3:1 for large text, 4.5:1 otherwise. */
function contrastCheck(node: AxeNodeLike): ContrastCheck {
  const data = node.any?.[0]?.data;
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const required = /^([0-9.]+):1$/.exec(String(record.expectedContrastRatio ?? ""))?.[1];
  return {
    reason: String(record.messageKey ?? ""),
    requiredRatio: required ? Number(required) : 4.5
  };
}

/** A node in the page itself; one inside a frame or shadow root has a longer target. */
function singleSelector(node: AxeNodeLike): string | undefined {
  return node.target.length === 1 && typeof node.target[0] === "string"
    ? node.target[0]
    : undefined;
}

/** The rule's result list with these nodes added to its entry, or a new entry for them. */
function withNodes<Node extends AxeNodeLike>(
  rules: Array<AxeRuleLike<Node>>,
  template: AxeRuleLike<Node>,
  nodes: Node[]
): Array<AxeRuleLike<Node>> {
  if (nodes.length === 0) return rules;
  const existing = rules.find(({ id }) => id === template.id);
  return existing
    ? rules.map((entry) =>
        entry === existing ? { ...entry, nodes: [...entry.nodes, ...nodes] } : entry
      )
    : [...rules, { ...template, nodes }];
}

/** A failing node described in axe's own words, so reports read its colors and required ratio. */
function withMeasuredFailure<Node extends AxeNodeLike>(
  node: Node,
  measurement: MeasuredContrast
): Node {
  const { foreground, lowest, highest, requiredRatio } = measurement;
  const message = `Measured from the screenshot, the text has a contrast of ${lowest.ratio} to ${highest.ratio} against what is behind it (foreground color: ${foreground}, background color: ${lowest.background}; foreground color: ${foreground}, background color: ${highest.background}). Expected contrast ratio of ${requiredRatio}:1`;
  const [first, ...rest] = node.any ?? [];
  return {
    ...node,
    any: [{ ...first, message }, ...rest],
    failureSummary: `Fix any of the following:\n  ${message}`
  };
}

/**
 * Measures each text in one full-page screenshot taken with those texts hidden, or returns
 * nothing when the screenshot times out, so the checks stay as axe left them.
 */
async function measureTexts(
  page: ContrastMeasuringPage,
  texts: Array<{ selector: string; requiredRatio: number }>
): Promise<ContrastMeasurement[] | undefined> {
  const probes = (await page.evaluate(probeTexts, {
    selectors: texts.map(({ selector }) => selector),
    attribute: PROBE_ATTRIBUTE
  })) as TextProbe[];
  let screenshot: unknown;
  try {
    screenshot = await page.screenshot({
      type: "png",
      fullPage: true,
      scale: "css",
      animations: "disabled",
      caret: "hide",
      timeout: 5_000
    });
  } catch (error) {
    if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
  } finally {
    await page.evaluate(releaseTexts, PROBE_ATTRIBUTE);
  }
  if (!(screenshot instanceof Uint8Array)) return undefined;
  const image = PNG.sync.read(Buffer.from(screenshot));
  return texts.map(({ requiredRatio }, index) => {
    const probe = probes[index]!;
    if ("unmeasured" in probe)
      return { verdict: "unmeasured", requiredRatio, reason: probe.unmeasured };
    return (
      measureAgainstPixels(
        probe.foreground,
        backgroundPixels(image, probe.rects),
        requiredRatio
      ) ?? {
        verdict: "unmeasured",
        requiredRatio,
        reason: "no pixels behind the text were on the screenshot"
      }
    );
  });
}

/** The RGB of every screenshot pixel inside the text's lines. */
function* backgroundPixels(image: PNG, rects: DOMRectInit[]): Generator<[number, number, number]> {
  for (const rect of rects) {
    const left = Math.max(0, Math.floor(rect.x ?? 0));
    const top = Math.max(0, Math.floor(rect.y ?? 0));
    const right = Math.min(image.width, Math.ceil((rect.x ?? 0) + (rect.width ?? 0)));
    const bottom = Math.min(image.height, Math.ceil((rect.y ?? 0) + (rect.height ?? 0)));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * image.width + x) * 4;
        yield [image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!];
      }
    }
  }
}

/**
 * The text's contrast against each background pixel, with a see-through text color blended onto
 * the pixel first, as WCAG measures it. Ratios are truncated to two decimals, as axe reports them.
 * Undefined when there are no pixels to measure.
 */
export function measureAgainstPixels(
  foreground: [number, number, number, number],
  pixels: Iterable<[number, number, number]>,
  requiredRatio: number
): MeasuredContrast | undefined {
  const alpha = foreground[3] / 255;
  let lowest: ContrastExtreme | undefined;
  let highest: ContrastExtreme | undefined;
  const seen = new Set<number>();
  for (const pixel of pixels) {
    const key = (pixel[0] << 16) | (pixel[1] << 8) | pixel[2];
    if (seen.has(key)) continue;
    seen.add(key);
    const text = pixel.map((channel, index) =>
      Math.round(foreground[index]! * alpha + channel * (1 - alpha))
    ) as [number, number, number];
    const ratio = Math.floor(contrastRatio(text, pixel) * 100) / 100;
    if (!lowest || ratio < lowest.ratio) lowest = { ratio, background: hex(pixel) };
    if (!highest || ratio > highest.ratio) highest = { ratio, background: hex(pixel) };
  }
  if (!lowest || !highest) return undefined;
  const verdict =
    lowest.ratio >= requiredRatio ? "pass" : highest.ratio < requiredRatio ? "fail" : "undecided";
  return {
    verdict,
    requiredRatio,
    foreground: hex(foreground.slice(0, 3) as [number, number, number]),
    lowest,
    highest
  };
}

function contrastRatio(first: [number, number, number], second: [number, number, number]): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** WCAG 2 relative luminance of an sRGB color. */
function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function hex(color: [number, number, number]): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Runs in the page. For each text: its color, as painted with every ancestor's opacity, and its
 * own lines in page coordinates, then hides its text so the screenshot shows what is behind it.
 * A text drawn with a shadow or an outline, or fixed on screen while the page is scrolled, is left
 * alone: hiding it would hide part of what makes it readable, or move it on a full-page capture.
 */
function probeTexts(request: { selectors: string[]; attribute: string }): TextProbe[] {
  const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const paint = (color: string): [number, number, number, number] => {
    canvas!.clearRect(0, 0, 1, 1);
    canvas!.fillStyle = color;
    canvas!.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = canvas!.getImageData(0, 0, 1, 1).data;
    return [red!, green!, blue!, alpha!];
  };
  const find = (selector: string): Element | null => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };
  const scrolled = scrollX !== 0 || scrollY !== 0;
  const probes = request.selectors.map((selector): TextProbe => {
    const element = find(selector);
    if (!element) return { unmeasured: "it is no longer on the page" };
    const style = getComputedStyle(element);
    if (style.textShadow !== "none" || parseFloat(style.webkitTextStrokeWidth) > 0) {
      return { unmeasured: "it has a text shadow or outline" };
    }
    let opacity = 1;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const currentStyle = getComputedStyle(current);
      opacity *= Number(currentStyle.opacity);
      if (scrolled && (currentStyle.position === "fixed" || currentStyle.position === "sticky")) {
        return { unmeasured: "it stays fixed on screen while the page is scrolled" };
      }
    }
    const [red, green, blue, alpha] = paint(style.color);
    const rects: DOMRectInit[] = [];
    for (const child of element.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) {
          rects.push({
            x: rect.x + scrollX,
            y: rect.y + scrollY,
            width: rect.width,
            height: rect.height
          });
        }
      }
    }
    if (rects.length === 0) return { unmeasured: "its text has no lines on the page" };
    element.setAttribute(request.attribute, "");
    return { foreground: [red, green, blue, Math.round(alpha * opacity)], rects };
  });
  const hide = document.createElement("style");
  hide.setAttribute(request.attribute, "style");
  hide.textContent = `[${request.attribute}=""] { color: transparent !important; -webkit-text-fill-color: transparent !important; }`;
  (document.head ?? document.documentElement).append(hide);
  return probes;
}

/** Runs in the page: shows the probed texts again. */
function releaseTexts(attribute: string): void {
  for (const element of document.querySelectorAll(`[${attribute}]`)) {
    if (element.getAttribute(attribute) === "style") element.remove();
    else element.removeAttribute(attribute);
  }
}
