import type { CheckResult, NodeResult, Result, UnlabelledFrameSelector } from "axe-core";

import type { ContrastMeasurement, MeasuredContrast } from "./contrast-measurement";
import type { ElementContext } from "./element-context";
import type { ElementLocation } from "./element-locations";
import type { FrameNotChecked } from "./frames-not-checked";

/**
 * axe's path to an element, as its `target` gives it: one entry per document, outermost first,
 * so every entry but the last is an `<iframe>`. An entry that is itself a list steps into shadow
 * roots: its first selector finds the host, and each next one is matched inside the shadow root
 * of the element before it.
 */
export type AxeTarget = UnlabelledFrameSelector;

/** One document's part of an {@link AxeTarget}: a selector, or a path through shadow roots. */
export type AxeTargetStep = AxeTarget[number];

/**
 * An axe result file as AEE writes it at a checkpoint, as far as `axe-result.schema.json` checks
 * it: the axe-core 4.14 fields AEE reads, with axe's own types, and AEE's additions. axe's other
 * fields are in the file too, unchecked, so they are left out here.
 */
export interface AxeResultFile {
  violations: AxeResultRule[];
  incomplete: AxeResultRule[];
  /** Read only for how many there are. */
  passes: unknown[];
  inapplicable: unknown[];
  /** Frames left out of the analysis; absent when every frame was checked. */
  framesNotChecked?: FrameNotChecked[];
}

/** One rule's result: axe's `Result`, as far as AEE reads it. */
export interface AxeResultRule extends Pick<
  Result,
  "id" | "impact" | "help" | "description" | "helpUrl" | "tags"
> {
  nodes: AxeResultNode[];
}

/** One element a rule found: axe's `NodeResult`, as far as AEE reads it, and AEE's additions. */
export interface AxeResultNode extends Pick<NodeResult, "html" | "target" | "failureSummary"> {
  any: Array<Pick<CheckResult, "id" | "message" | "data">>;
  /** Where a violation's element sits on the full-page screenshot, when AEE found it there. */
  aeeTarget?: ElementLocation;
  /** The page around a violation's element an AI specialist may be asked about. */
  aeeContext?: ElementContext;
  /** AEE's measurement of the pixels behind a text whose contrast axe could not decide. */
  aeeContrast?: ContrastMeasurement;
}

/**
 * A text's contrast as it was measured: by axe from the page's styles, or by AEE from the
 * screenshot's pixels when axe could not tell what is behind the text.
 */
export interface ContrastReading {
  measuredBy: "axe" | "screenshot";
  foreground: string;
  /**
   * The background or backgrounds it was measured against, each with its contrast ratio: axe
   * gives one; the screenshot gives the lowest and the highest when they differ.
   */
  backgrounds: Array<{ color: string; ratio: number }>;
  /** The ratio WCAG asks of this text: 3 for large text, 4.5 otherwise. */
  requiredRatio: number;
  /** axe's own reading of the text's size and weight, such as "12.0pt (16px)" and "normal". */
  fontSize?: string;
  fontWeight?: string;
}

/** What axe's `color-contrast` check recorded about a node in its `data`. */
export interface AxeContrastData {
  /** Why axe could not decide, such as `bgGradient`; absent when it measured the text. */
  messageKey?: string;
  foreground?: string;
  background?: string;
  ratio?: number;
  requiredRatio?: number;
  fontSize?: string;
  fontWeight?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * axe's path as one line a person can read: frames joined by "→", and each step into a shadow
 * root by ">>>", the deep combinator Puppeteer and WebdriverIO accept for the same path. The page
 * runs it too (`element-selectors`), so it uses nothing from outside itself.
 */
export function describeAxeTarget(target: AxeTarget): string {
  return target.map((step) => (Array.isArray(step) ? step.join(" >>> ") : step)).join(" → ");
}

/** The node's `color-contrast` check data, read by its fields; undefined for any other node. */
export function axeContrastData(node: unknown): AxeContrastData | undefined {
  const checks = isRecord(node) && Array.isArray(node.any) ? node.any : [];
  const check = checks.find((entry) => isRecord(entry) && entry.id === "color-contrast");
  if (!isRecord(check) || !isRecord(check.data)) return undefined;
  const { data } = check;
  // axe writes the required ratio as "4.5:1".
  const required = /^([0-9.]+):1$/.exec(String(data.expectedContrastRatio ?? ""))?.[1];
  return {
    ...(optionalString(data.messageKey) ? { messageKey: String(data.messageKey) } : {}),
    ...(optionalString(data.fgColor) ? { foreground: String(data.fgColor) } : {}),
    ...(optionalString(data.bgColor) ? { background: String(data.bgColor) } : {}),
    ...(typeof data.contrastRatio === "number" ? { ratio: data.contrastRatio } : {}),
    ...(required ? { requiredRatio: Number(required) } : {}),
    ...(optionalString(data.fontSize) ? { fontSize: String(data.fontSize) } : {}),
    ...(optionalString(data.fontWeight) ? { fontWeight: String(data.fontWeight) } : {})
  };
}

function isMeasuredContrast(value: unknown): value is MeasuredContrast {
  const measurement = value as ContrastMeasurement | undefined;
  return isRecord(measurement) && measurement.verdict !== "unmeasured" && "lowest" in measurement;
}

/**
 * A node's contrast from the structured data: AEE's screenshot measurement when it settled the
 * text, otherwise axe's own measurement. Undefined when neither measured it.
 */
export function contrastReading(node: unknown): ContrastReading | undefined {
  const data = axeContrastData(node);
  const font = {
    ...(data?.fontSize ? { fontSize: data.fontSize } : {}),
    ...(data?.fontWeight ? { fontWeight: data.fontWeight } : {})
  };
  const measured = isRecord(node) ? node.aeeContrast : undefined;
  if (isMeasuredContrast(measured)) {
    const { lowest, highest } = measured;
    return {
      measuredBy: "screenshot",
      foreground: measured.foreground,
      backgrounds: [lowest, highest]
        .filter((extreme, index) => index === 0 || extreme.background !== lowest.background)
        .map(({ background, ratio }) => ({ color: background, ratio })),
      requiredRatio: measured.requiredRatio,
      ...font
    };
  }
  if (
    !data?.foreground ||
    !data.background ||
    data.ratio === undefined ||
    data.requiredRatio === undefined
  ) {
    return undefined;
  }
  return {
    measuredBy: "axe",
    foreground: data.foreground,
    backgrounds: [{ color: data.background, ratio: data.ratio }],
    requiredRatio: data.requiredRatio,
    ...font
  };
}
