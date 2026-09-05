import type { ProposedFix } from "@aee/core";

export interface AccessibleLabelContext {
  selector: string;
  role: string;
  currentAccessibleName?: string;
  iconDescription?: string;
  nearbyHeading?: string;
  nearbyText?: string;
  destinationText?: string;
}

export interface AccessibleLabelSuggestion {
  label: string;
  rationale: string;
  confidence: number;
}

export interface AccessibleLabelModelProvider {
  id: string;
  suggestLabel(context: AccessibleLabelContext): Promise<AccessibleLabelSuggestion>;
}

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
      kind: "decorative-classification";
      hasVisualContext: boolean;
      meaningDependsOnRelationship: boolean;
    }
  | {
      kind: "deterministic-rule";
      ruleId: string;
    };

export interface AiReviewDecision {
  route: "ai-review" | "deterministic";
  reason: string;
}

export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
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
    if (!candidate.contextSignals.some((signal) => signal.trim())) {
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

  if (candidate.hasVisualContext && candidate.meaningDependsOnRelationship) {
    return {
      route: "ai-review",
      reason: "Decorative status depends on whether the visual adds meaning beyond nearby content."
    };
  }
  return {
    route: "deterministic",
    reason: "The available evidence does not require visual relationship interpretation."
  };
}

export async function proposeAccessibleLabelFix(
  context: AccessibleLabelContext,
  provider: AccessibleLabelModelProvider
): Promise<ProposedFix> {
  const decision = routeContextualReview({
    kind: "icon-label",
    hasAccessibleName: Boolean(context.currentAccessibleName?.trim()),
    isIconOnly: Boolean(context.iconDescription?.trim()),
    contextSignals: [context.nearbyHeading, context.nearbyText, context.destinationText].filter(
      (value): value is string => Boolean(value?.trim())
    )
  });

  if (decision.route !== "ai-review") {
    throw new Error(`AI review was not triggered: ${decision.reason}`);
  }

  const suggestion = validateSuggestion(await provider.suggestLabel(context));
  const escapedLabel = escapeHtmlAttribute(suggestion.label);

  return {
    providerId: provider.id,
    summary: `Propose accessible name "${suggestion.label}" for ${context.selector}.`,
    rationale: `${decision.reason} ${suggestion.rationale} Model confidence: ${suggestion.confidence.toFixed(2)}. This proposal requires human review and a verified rerun.`,
    safety: "review",
    patches: [`${context.selector}: add aria-label="${escapedLabel}"`]
  };
}

export function createOpenAiResponsesLabelProvider(
  options: OpenAiResponsesProviderOptions
): AccessibleLabelModelProvider {
  if (!options.apiKey.trim()) {
    throw new Error("An OpenAI API key is required.");
  }

  if (!options.model.trim()) {
    throw new Error("An OpenAI model is required.");
  }

  const activeFetch = options.fetch ?? globalThis.fetch;

  if (!activeFetch) {
    throw new Error("A Fetch API implementation is required.");
  }

  return {
    id: `openai-responses:${options.model}`,
    async suggestLabel(context) {
      const response = await activeFetch(
        `${options.baseUrl ?? "https://api.openai.com/v1"}/responses`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: options.model,
            store: false,
            instructions:
              "Suggest a concise accessible name for the unnamed control. Use only the supplied UI context. Do not claim certainty about purpose that the context does not support.",
            input: JSON.stringify(context),
            text: {
              format: {
                type: "json_schema",
                name: "accessible_label_suggestion",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string", minLength: 1, maxLength: 120 },
                    rationale: { type: "string", minLength: 1, maxLength: 500 },
                    confidence: { type: "number", minimum: 0, maximum: 1 }
                  },
                  required: ["label", "rationale", "confidence"]
                }
              }
            }
          })
        }
      );

      if (!response.ok) {
        throw new Error(`OpenAI Responses request failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as { output_text?: unknown };

      if (typeof payload.output_text !== "string") {
        throw new Error("OpenAI Responses output did not include output_text.");
      }

      return validateSuggestion(JSON.parse(payload.output_text));
    }
  };
}

function validateSuggestion(value: unknown): AccessibleLabelSuggestion {
  if (!isRecord(value)) {
    throw new Error("Accessible-label suggestion must be an object.");
  }

  const label = typeof value.label === "string" ? value.label.trim() : "";
  const rationale = typeof value.rationale === "string" ? value.rationale.trim() : "";
  const confidence = value.confidence;

  if (!label || label.length > 120) {
    throw new Error("Accessible-label suggestion must contain a label of 1 to 120 characters.");
  }

  if (!rationale || rationale.length > 500) {
    throw new Error("Accessible-label suggestion must contain a concise rationale.");
  }

  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new Error("Accessible-label suggestion confidence must be between 0 and 1.");
  }

  return { label, rationale, confidence };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
