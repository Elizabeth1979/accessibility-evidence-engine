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

export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export async function proposeAccessibleLabelFix(
  context: AccessibleLabelContext,
  provider: AccessibleLabelModelProvider
): Promise<ProposedFix> {
  const suggestion = validateSuggestion(await provider.suggestLabel(context));
  const escapedLabel = escapeHtmlAttribute(suggestion.label);

  return {
    providerId: provider.id,
    summary: `Propose accessible name "${suggestion.label}" for ${context.selector}.`,
    rationale: `${suggestion.rationale} Model confidence: ${suggestion.confidence.toFixed(2)}. This proposal requires human review and a verified rerun.`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
