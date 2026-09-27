import Anthropic from "@anthropic-ai/sdk";

/** The JSON Schema of a specialist's answer: an object whose every field is required. */
export type AnswerSchema = {
  type: "object";
  additionalProperties: false;
  properties: Record<string, unknown>;
  required: string[];
};

/** What a specialist asks a model: fixed instructions, the evidence as JSON, and the answer's shape. */
export interface ModelRequest {
  /** Names the answer's shape, for APIs that want one. */
  name: string;
  instructions: string;
  input: unknown;
  schema: AnswerSchema;
}

/** A model behind one seam. Its answer is parsed JSON, not yet checked: the specialist checks it. */
export interface ModelProvider {
  id: string;
  ask(request: ModelRequest): Promise<unknown>;
}

/** Which model answers. "auto" is Claude when an Anthropic key is set, else the stub. */
export type ModelProviderName = "auto" | "claude" | "openai" | "local" | "stub";

export const MODEL_PROVIDER_NAMES: readonly ModelProviderName[] = [
  "auto",
  "claude",
  "openai",
  "local",
  "stub"
];

/** Thrown by the stub: no model is configured, so there is no answer, never an invented one. */
export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "AI suggestions are not configured. Set ANTHROPIC_API_KEY for Claude, or AEE_LLM_PROVIDER=local for a local model, or AEE_LLM_PROVIDER=openai with OPENAI_API_KEY and AEE_LLM_MODEL."
    );
    this.name = "AiNotConfiguredError";
  }
}

export interface CreateModelProviderOptions {
  /** Defaults to AEE_LLM_PROVIDER, else "auto". */
  provider?: ModelProviderName;
  /** Where configuration is read from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** A preconfigured Claude client (tests, a proxy). */
  claudeClient?: Anthropic;
  /** The Fetch implementation for the OpenAI and local providers. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Picks the model provider from configuration, so switching models needs no code change:
 * - AEE_LLM_PROVIDER: auto (default), claude, openai, local or stub;
 * - AEE_LLM_MODEL: the model for whichever provider is chosen;
 * - ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN: makes "auto" choose Claude;
 * - OPENAI_API_KEY: required by "openai", with AEE_LLM_MODEL;
 * - AEE_LLM_BASE_URL and AEE_LLM_API_KEY: the local server, Ollama by default.
 * With nothing set, the stub is chosen and no request leaves the machine.
 */
export function createModelProvider(options: CreateModelProviderOptions = {}): ModelProvider {
  const env = options.env ?? process.env;
  const provider = options.provider ?? parseModelProviderName(env.AEE_LLM_PROVIDER) ?? "auto";
  const model = env.AEE_LLM_MODEL;

  if (provider === "local") {
    return createLocalModelProvider({
      baseUrl: env.AEE_LLM_BASE_URL,
      model,
      apiKey: env.AEE_LLM_API_KEY,
      fetch: options.fetch
    });
  }
  if (provider === "openai") {
    return createOpenAiResponsesModelProvider({
      apiKey: env.OPENAI_API_KEY ?? "",
      model: model ?? "",
      fetch: options.fetch
    });
  }
  const hasClaudeKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  if (provider === "claude" || (provider === "auto" && hasClaudeKey)) {
    return createClaudeModelProvider({ model, client: options.claudeClient });
  }
  return createStubModelProvider();
}

/** Reads a provider name such as AEE_LLM_PROVIDER; unset is undefined, and an unknown name throws. */
export function parseModelProviderName(value: string | undefined): ModelProviderName | undefined {
  if (!value) return undefined;
  if ((MODEL_PROVIDER_NAMES as readonly string[]).includes(value)) {
    return value as ModelProviderName;
  }
  throw new Error(
    `AEE_LLM_PROVIDER must be one of ${MODEL_PROVIDER_NAMES.join(", ")}; got "${value}".`
  );
}

/** The provider used when no model is configured. It never answers. */
export function createStubModelProvider(): ModelProvider {
  return {
    id: "stub",
    async ask() {
      throw new AiNotConfiguredError();
    }
  };
}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

export interface ClaudeModelProviderOptions {
  /** Defaults to the SDK's own lookup: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, a saved login. */
  apiKey?: string;
  /** Defaults to DEFAULT_CLAUDE_MODEL. */
  model?: string;
  /** A preconfigured client (tests, a proxy); takes precedence over apiKey. */
  client?: Anthropic;
}

/** Claude, through the Anthropic SDK, with the answer constrained to the request's schema. */
export function createClaudeModelProvider(options: ClaudeModelProviderOptions = {}): ModelProvider {
  const client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;

  return {
    id: `claude:${model}`,
    async ask(request) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // A declined request is re-run on the model Anthropic recommends for that refusal category.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: request.instructions,
        messages: [{ role: "user", content: JSON.stringify(request.input) }],
        output_config: { format: { type: "json_schema", schema: request.schema } }
      });

      if (response.stop_reason === "refusal") {
        throw new Error(
          `Claude declined to answer (${response.stop_details?.category ?? "no category given"}).`
        );
      }
      const text = response.content.find((block) => block.type === "text");
      if (!text) {
        throw new Error("Claude returned no structured answer.");
      }
      return JSON.parse(text.text);
    }
  };
}

export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_LOCAL_MODEL = "gemma4:e4b";

export interface LocalModelProviderOptions {
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
 * API: no key and no cloud. Local runtimes cannot enforce a schema, so the prompt carries it and
 * the specialist checks the answer.
 */
export function createLocalModelProvider(options: LocalModelProviderOptions = {}): ModelProvider {
  const baseUrl = withoutTrailingSlashes(options.baseUrl ?? DEFAULT_LOCAL_BASE_URL);
  const model = options.model ?? DEFAULT_LOCAL_MODEL;
  const activeFetch = options.fetch ?? globalThis.fetch;

  return {
    id: `local:${model}`,
    async ask(request) {
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
              content: `${request.instructions}\nRespond with only a JSON object that matches this JSON Schema, with no markdown:\n${JSON.stringify(request.schema)}`
            },
            { role: "user", content: JSON.stringify(request.input) }
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
      return JSON.parse(content);
    }
  };
}

export interface OpenAiResponsesModelProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export function createOpenAiResponsesModelProvider(
  options: OpenAiResponsesModelProviderOptions
): ModelProvider {
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
    async ask(request) {
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
            instructions: request.instructions,
            input: JSON.stringify(request.input),
            text: {
              format: {
                type: "json_schema",
                name: request.name,
                strict: true,
                schema: request.schema
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

      return JSON.parse(payload.output_text);
    }
  };
}

/** A loop, not a regex: the URL comes from configuration, and /\/+$/ is slow on many slashes. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}
