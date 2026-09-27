import type { ProposedFix } from "@aee/core";

import type { ModelProvider } from "./model-providers";
import {
  accessibleNameSpecialist,
  askSpecialist,
  imagePurposeSpecialist,
  type AccessibleLabelContext,
  type AccessibleNameAnswer,
  type ImagePurposeAnswer,
  type ImagePurposeContext,
  type ImageRole,
  type Specialist
} from "./specialists";

export * from "./model-providers";
export * from "./specialists";

export type ContextualReviewCandidate =
  | {
      kind: "icon-label";
      hasAccessibleName: boolean;
      isIconOnly: boolean;
      contextSignals: string[];
    }
  | {
      kind: "heading-structure";
      hasFullPageContext: boolean;
      needsSemanticOutline: boolean;
    }
  | {
      kind: "image-purpose";
      /** The role the markup already decides, if any (imageRoleFromMarkup). */
      markupRole?: ImageRole;
      contextSignals: string[];
    }
  | {
      kind: "deterministic-rule";
      ruleId: string;
    };

export interface AiReviewDecision {
  route: "ai-review" | "deterministic";
  reason: string;
}

export interface PaletteColor {
  name: string;
  value: string;
}

export interface PaletteContrastContext {
  selector: string;
  foreground: string;
  background: string;
  palette: PaletteColor[];
  minimumRatio?: number;
  cssProperty?: "color" | "background-color" | "border-color";
}

export interface PaletteContrastSuggestion {
  currentRatio: number;
  minimumRatio: number;
  selected: PaletteColor;
  selectedRatio: number;
  colorDistance: number;
  proposal: ProposedFix;
}

/** Selects the perceptually closest existing palette color that clears the required contrast. */
export function suggestPaletteContrastFix(
  context: PaletteContrastContext
): PaletteContrastSuggestion {
  const foreground = parseHexColor(context.foreground);
  const background = parseHexColor(context.background);
  const minimumRatio = context.minimumRatio ?? 4.5;

  if (!Number.isFinite(minimumRatio) || minimumRatio <= 1 || minimumRatio > 21) {
    throw new Error("Minimum contrast ratio must be greater than 1 and no more than 21.");
  }

  const currentRatio = contrastRatio(foreground, background);

  if (currentRatio >= minimumRatio) {
    throw new Error(
      `Current foreground already meets the ${formatRatio(minimumRatio)} contrast requirement.`
    );
  }

  const candidates = context.palette.map((color) => {
    const parsed = parseHexColor(color.value);

    return {
      color: { name: color.name.trim(), value: normalizeHex(parsed) },
      ratio: contrastRatio(parsed, background),
      distance: oklabDistance(foreground, parsed)
    };
  });
  const passing = candidates
    .filter((candidate) => candidate.color.name && candidate.ratio >= minimumRatio)
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        right.ratio - left.ratio ||
        left.color.name.localeCompare(right.color.name)
    );
  const best = passing[0];

  if (!best) {
    throw new Error(
      `No supplied palette color meets the ${formatRatio(minimumRatio)} contrast requirement.`
    );
  }

  const cssProperty = context.cssProperty ?? "color";

  return {
    currentRatio: roundRatio(currentRatio),
    minimumRatio,
    selected: best.color,
    selectedRatio: roundRatio(best.ratio),
    colorDistance: Number(best.distance.toFixed(4)),
    proposal: {
      providerId: "aee-palette-contrast",
      summary: `Use ${best.color.name} (${best.color.value}) for ${context.selector}.`,
      rationale: `It is the perceptually closest supplied palette color to ${normalizeHex(foreground)} that meets the ${formatRatio(minimumRatio)} requirement against ${normalizeHex(background)}. The measured ratio changes from ${formatRatio(currentRatio)} to ${formatRatio(best.ratio)}.`,
      safety: "review",
      patches: [`${context.selector}: set ${cssProperty}: ${best.color.value}`]
    }
  };
}

/** Keeps model calls behind an explicit allowlist of context-dependent cases. */
export function routeContextualReview(candidate: ContextualReviewCandidate): AiReviewDecision {
  if (candidate.kind === "deterministic-rule") {
    return {
      route: "deterministic",
      reason: `${candidate.ruleId} can be evaluated without interpreting visual or page context.`
    };
  }

  if (candidate.kind === "icon-label") {
    if (candidate.hasAccessibleName) {
      return { route: "deterministic", reason: "The control already has an accessible name." };
    }
    if (!candidate.isIconOnly) {
      return {
        route: "deterministic",
        reason: "The control is not icon-only, so its visible text should supply the name."
      };
    }
    if (!hasSignal(candidate.contextSignals)) {
      return {
        route: "deterministic",
        reason: "No bounded UI context is available from which to infer the icon's purpose."
      };
    }
    return {
      route: "ai-review",
      reason:
        "The icon-only control needs a product-specific name inferred from surrounding UI context."
    };
  }

  if (candidate.kind === "heading-structure") {
    if (candidate.hasFullPageContext && candidate.needsSemanticOutline) {
      return {
        route: "ai-review",
        reason:
          "The intended heading hierarchy depends on the meaning and organization of the full page."
      };
    }
    return {
      route: "deterministic",
      reason:
        "A mechanical heading defect can be reported without asking a model to redesign the outline."
    };
  }

  if (candidate.markupRole === "decorative") {
    return {
      route: "deterministic",
      reason: "The markup already marks the image decorative, so its alternative is empty."
    };
  }
  if (!hasSignal(candidate.contextSignals)) {
    return {
      route: "deterministic",
      reason: "No bounded page context is available from which to infer the image's purpose."
    };
  }
  return {
    route: "ai-review",
    reason:
      "Whether the image is decorative, informative, functional or complex, and what its alternative says, depends on the page around it."
  };
}

function hasSignal(signals: string[]): boolean {
  return signals.some((signal) => signal.trim());
}

/** A review-only fix, with the specialist's answer it came from. */
export type AiProposedFix<Answer> = ProposedFix & { answer: Answer };

/** Suggests a name for an icon-only control, when the allowlist routes it to AI. */
export async function proposeAccessibleLabelFix(
  context: AccessibleLabelContext,
  provider: ModelProvider
): Promise<AiProposedFix<AccessibleNameAnswer>> {
  const decision = routeContextualReview({
    kind: "icon-label",
    hasAccessibleName: Boolean(context.currentAccessibleName?.trim()),
    isIconOnly: Boolean(context.iconDescription?.trim()),
    contextSignals: definedSignals(
      context.nearbyHeading,
      context.nearbyText,
      context.destinationText
    )
  });
  const answer = await askAllowed(decision, accessibleNameSpecialist, context, provider);

  return reviewOnlyFix(provider, decision, answer, {
    summary: `Propose accessible name "${answer.suggestedName}" for ${context.selector}.`,
    patch: `${context.selector}: add aria-label="${escapeHtmlAttribute(answer.suggestedName)}"`
  });
}

/** Classifies an image and drafts its alternative, when the allowlist routes it to AI. */
export async function proposeImageAlternativeFix(
  context: ImagePurposeContext,
  provider: ModelProvider
): Promise<AiProposedFix<ImagePurposeAnswer>> {
  const decision = routeContextualReview({
    kind: "image-purpose",
    markupRole: context.markupRole,
    contextSignals: definedSignals(
      context.linkOrButtonText,
      context.destinationText,
      context.caption,
      context.title,
      context.nearbyHeading,
      context.nearbyText
    )
  });
  const answer = await askAllowed(decision, imagePurposeSpecialist, context, provider);

  return reviewOnlyFix(provider, decision, answer, {
    summary: `Classify ${context.selector} as ${answer.classification} and propose ${answer.suggestedAlternative ? `alternative "${answer.suggestedAlternative}"` : "an empty alternative"}.`,
    patch: `${context.selector}: set alt="${escapeHtmlAttribute(answer.suggestedAlternative)}"`
  });
}

async function askAllowed<Input extends object, Answer>(
  decision: AiReviewDecision,
  specialist: Specialist<Input, Answer>,
  input: Input,
  provider: ModelProvider
): Promise<Answer> {
  if (decision.route !== "ai-review") {
    throw new Error(`AI review was not triggered: ${decision.reason}`);
  }
  return askSpecialist(specialist, input, provider);
}

function reviewOnlyFix<Answer extends { rationale: string; confidence: number }>(
  provider: ModelProvider,
  decision: AiReviewDecision,
  answer: Answer,
  proposal: { summary: string; patch: string }
): AiProposedFix<Answer> {
  return {
    providerId: provider.id,
    summary: proposal.summary,
    rationale: `${decision.reason} ${answer.rationale} Model confidence: ${answer.confidence.toFixed(2)}. This proposal requires human review and a verified rerun.`,
    safety: "review",
    patches: [proposal.patch],
    answer
  };
}

function definedSignals(...values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value?.trim()));
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

function parseHexColor(value: string): RgbColor {
  const normalized = value.trim().replace(/^#/, "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : normalized;

  if (!/^[0-9a-f]{6}$/i.test(expanded)) {
    throw new Error(`Unsupported color "${value}". Use a three- or six-digit hex color.`);
  }

  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16)
  };
}

function normalizeHex(color: RgbColor): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function contrastRatio(left: RgbColor, right: RgbColor): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: RgbColor): number {
  const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

function oklabDistance(left: RgbColor, right: RgbColor): number {
  const first = toOklab(left);
  const second = toOklab(right);
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function toOklab(color: RgbColor): [number, number, number] {
  const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * red! + 0.5363325363 * green! + 0.0514459929 * blue!);
  const m = Math.cbrt(0.2119034982 * red! + 0.6806995451 * green! + 0.1073969566 * blue!);
  const s = Math.cbrt(0.0883024619 * red! + 0.2817188376 * green! + 0.6299787005 * blue!);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function roundRatio(value: number): number {
  return Number(value.toFixed(2));
}

function formatRatio(value: number): string {
  return `${roundRatio(value).toFixed(2)}:1`;
}
