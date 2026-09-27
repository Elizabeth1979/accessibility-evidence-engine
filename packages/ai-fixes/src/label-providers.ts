import Anthropic from "@anthropic-ai/sdk";

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

/** Which model suggests labels. "auto" is Claude when an Anthropic key is set, else the stub. */
export type LabelProviderName = "auto" | "claude" | "openai" | "local" | "stub";

const LABEL_PROVIDER_NAMES: readonly LabelProviderName[] = [
  "auto",
  "claude",
  "openai",
  "local",
  "stub"
];

const LABEL_INSTRUCTIONS =
  "Suggest a concise accessible name for the unnamed control. Use only the supplied UI context. Do not claim certainty about purpose that the context does not support.";

/**
 * The suggestion every provider returns. Its limits are checked by validateSuggestion on every
 * answer, because Claude's structured outputs accept no length or range limits in a schema.
 */
const LABEL_SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "number" }
  },
  required: ["label", "rationale", "confidence"]
};

/** Thrown by the stub: no model is configured, so there is no suggestion, never an invented one. */
export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "AI label suggestions are not configured. Set ANTHROPIC_API_KEY for Claude, or AEE_LLM_PROVIDER=local for a local model, or AEE_LLM_PROVIDER=openai with OPENAI_API_KEY and AEE_LLM_MODEL."
    );
    this.name = "AiNotConfiguredError";
  }
}

export interface CreateLabelProviderOptions {
  /** Defaults to AEE_LLM_PROVIDER, else "auto". */
  provider?: LabelProviderName;
  /** Where configuration is read from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** A preconfigured Claude client (tests, a proxy). */
  claudeClient?: Anthropic;
  /** The Fetch implementation for the OpenAI and local providers. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Picks the label provider from configuration, so switching models needs no code change:
 * - AEE_LLM_PROVIDER: auto (default), claude, openai, local or stub;
 * - AEE_LLM_MODEL: the model for whichever provider is chosen;
 * - ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN: makes "auto" choose Claude;
 * - OPENAI_API_KEY: required by "openai", with AEE_LLM_MODEL;
 * - AEE_LLM_BASE_URL and AEE_LLM_API_KEY: the local server, Ollama by default.
 * With nothing set, the stub is chosen and no request leaves the machine.
 */
export function createLabelProvider(
  options: CreateLabelProviderOptions = {}
): AccessibleLabelModelProvider {
  const env = options.env ?? process.env;
  const provider = options.provider ?? parseProviderName(env.AEE_LLM_PROVIDER);
  const model = env.AEE_LLM_MODEL;

  if (provider === "local") {
    return createLocalLabelProvider({
      baseUrl: env.AEE_LLM_BASE_URL,
      model,
      apiKey: env.AEE_LLM_API_KEY,
      fetch: options.fetch
    });
  }
  if (provider === "openai") {
    return createOpenAiResponsesLabelProvider({
      apiKey: env.OPENAI_API_KEY ?? "",
      model: model ?? "",
      fetch: options.fetch
    });
  }
  const hasClaudeKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  if (provider === "claude" || (provider === "auto" && hasClaudeKey)) {
    return createClaudeLabelProvider({ model, client: options.claudeClient });
  }
  return createStubLabelProvider();
}

function parseProviderName(value: string | undefined): LabelProviderName {
  if (!value) return "auto";
  if ((LABEL_PROVIDER_NAMES as readonly string[]).includes(value)) {
    return value as LabelProviderName;
  }
  throw new Error(
    `AEE_LLM_PROVIDER must be one of ${LABEL_PROVIDER_NAMES.join(", ")}; got "${value}".`
  );
}

/** The provider used when no model is configured. It never suggests a label. */
export function createStubLabelProvider(): AccessibleLabelModelProvider {
  return {
    id: "stub",
    async suggestLabel() {
      throw new AiNotConfiguredError();
    }
  };
}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

export interface ClaudeLabelProviderOptions {
  /** Defaults to the SDK's own lookup: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, a saved login. */
  apiKey?: string;
  /** Defaults to DEFAULT_CLAUDE_MODEL. */
  model?: string;
  /** A preconfigured client (tests, a proxy); takes precedence over apiKey. */
  client?: Anthropic;
}

/** Claude, through the Anthropic SDK, with the answer constrained to the suggestion schema. */
export function createClaudeLabelProvider(
  options: ClaudeLabelProviderOptions = {}
): AccessibleLabelModelProvider {
  const client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;

  return {
    id: `claude:${model}`,
    async suggestLabel(context) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // A declined request is re-run on the model Anthropic recommends for that refusal category.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: LABEL_INSTRUCTIONS,
        messages: [{ role: "user", content: JSON.stringify(context) }],
        output_config: { format: { type: "json_schema", schema: LABEL_SUGGESTION_SCHEMA } }
      });

      if (response.stop_reason === "refusal") {
        throw new Error(
          `Claude declined to suggest a label (${response.stop_details?.category ?? "no category given"}).`
        );
      }
      const text = response.content.find((block) => block.type === "text");
      if (!text) {
        throw new Error("Claude returned no structured suggestion.");
      }
      return validateSuggestion(JSON.parse(text.text));
    }
  };
}

export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_LOCAL_MODEL = "gemma4:e4b";

export interface LocalLabelProviderOptions {
  /** An OpenAI-compatible base URL; defaults to Ollama's. */
  baseUrl?: string;
  /** The model as the local runtime names it; defaults to DEFAULT_LOCAL_MODEL. */
  model?: string;
  /** Most local runtimes ignore it; vLLM and hosted gateways may require it. */
  apiKey?: string;
  /** A cold local model can take a while to load on its first request. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * A model on this machine (Ollama, LM Studio, llama.cpp, vLLM) through the OpenAI-compatible chat
 * API: no key and no cloud. Local runtimes cannot enforce a schema, so the prompt asks for the
 * JSON object and validateSuggestion checks it.
 */
export function createLocalLabelProvider(
  options: LocalLabelProviderOptions = {}
): AccessibleLabelModelProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_LOCAL_MODEL;
  const activeFetch = options.fetch ?? globalThis.fetch;

  return {
    id: `local:${model}`,
    async suggestLabel(context) {
      const response = await activeFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${LABEL_INSTRUCTIONS}\nRespond with only a JSON object with the keys label, rationale and confidence (a number from 0 to 1), with no markdown.`
            },
            { role: "user", content: JSON.stringify(context) }
          ]
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000)
      });

      if (!response.ok) {
        throw new Error(`Local model request failed with status ${response.status}.`);
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Local model response had no message content.");
      }
      return validateSuggestion(JSON.parse(content));
    }
  };
}

export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
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
            instructions: LABEL_INSTRUCTIONS,
            input: JSON.stringify(context),
            text: {
              format: {
                type: "json_schema",
                name: "accessible_label_suggestion",
                strict: true,
                schema: LABEL_SUGGESTION_SCHEMA
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

/** Checks a suggestion from any provider against the limits the schema cannot carry everywhere. */
export function validateSuggestion(value: unknown): AccessibleLabelSuggestion {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
