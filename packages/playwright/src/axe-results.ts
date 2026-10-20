import type { AxeTarget, ContrastMeasurement, MeasuredContrast } from "@aee/schemas";

export type {
  AxeImpact,
  AxeResultCheck,
  AxeResultFile,
  AxeResultNode,
  AxeResultRule,
  AxeTarget
} from "@aee/schemas";

/** One document's part of an {@link AxeTarget}: a selector, or a path through shadow roots. */
export type AxeTargetStep = AxeTarget[number];

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
