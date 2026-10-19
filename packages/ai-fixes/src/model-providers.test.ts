import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import Anthropic from "@anthropic-ai/sdk";

import {
  accessibleNameSpecialist,
  AiNotConfiguredError,
  askSpecialist,
  createClaudeModelProvider,
  createLocalModelProvider,
  createModelProvider,
  createOpenAiResponsesModelProvider,
  DEFAULT_LOCAL_BASE_URL,
  proposeAccessibleLabelFix,
  type AccessibleLabelContext
} from "./index";

const context: AccessibleLabelContext = {
  selector: "#archive-project",
  role: "button",
  iconDescription: "archive box",
  nearbyHeading: "Project Alpha",
  nearbyText: "Website accessibility review"
};

/** The schema every request for this context carries: citations limited to its fields. */
const schema = {
  ...accessibleNameSpecialist.schema,
  properties: {
    ...accessibleNameSpecialist.schema.properties,
    citedEvidenceIds: {
      type: "array",
      items: { type: "string", enum: Object.keys(context) }
    }
  }
};

const answer = {
  suggestedName: "Archive Project Alpha",
  rationale: "The archive icon sits in the Project Alpha row.",
  confidence: 0.9,
  citedEvidenceIds: ["iconDescription", "nearbyHeading"]
};

test("with nothing configured the stub is chosen, and it never invents an answer", async () => {
  const provider = createModelProvider({ env: {} });

  assert.equal(provider.id, "stub");
  await assert.rejects(proposeAccessibleLabelFix(context, provider), AiNotConfiguredError);
});

test("the provider is chosen from configuration", () => {
  assert.equal(
    createModelProvider({ env: { ANTHROPIC_API_KEY: "key" } }).id,
    "claude:claude-opus-5"
  );
  assert.equal(
    createModelProvider({ env: { AEE_LLM_PROVIDER: "local", AEE_LLM_MODEL: "tiny" } }).id,
    "local:tiny"
  );
  assert.equal(
    createModelProvider({
      env: { AEE_LLM_PROVIDER: "openai", OPENAI_API_KEY: "key", AEE_LLM_MODEL: "gpt" }
    }).id,
    "openai-responses:gpt"
  );
  // An explicit stub wins over a key that is present.
  assert.equal(
    createModelProvider({ env: { AEE_LLM_PROVIDER: "stub", ANTHROPIC_API_KEY: "key" } }).id,
    "stub"
  );
  assert.throws(
    () => createModelProvider({ env: { AEE_LLM_PROVIDER: "gemini" } }),
    /must be one of auto, claude, openai, local, stub/
  );
});

/** A Claude client whose requests land here instead of the network. */
function fakeClaude(reply: Record<string, unknown>) {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const client = new Anthropic({
    apiKey: "test-key",
    baseURL: "https://claude.test",
    maxRetries: 0,
    async fetch(_url, init) {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
          ...reply
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });
  return { client, requests };
}

test("Claude answers in the specialist's schema, with refusal fallbacks on", async () => {
  const { client, requests } = fakeClaude({
    content: [{ type: "text", text: JSON.stringify(answer) }],
    stop_reason: "end_turn"
  });

  const reply = await askSpecialist(
    accessibleNameSpecialist,
    context,
    createClaudeModelProvider({ client })
  );

  assert.deepEqual(reply, answer);
  const [request] = requests;
  assert.equal(request?.body.model, "claude-opus-5");
  assert.equal(request?.body.fallbacks, "default");
  assert.match(String(request?.body.system), /^# Accessibility engineer: system prompt/);
  assert.ok(String(request?.body.system).endsWith(accessibleNameSpecialist.instructions));
  assert.match(request?.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.deepEqual(
    (request?.body.output_config as { format: { schema: unknown } }).format.schema,
    schema
  );
  assert.equal(
    JSON.parse(String((request?.body.messages as [{ content: string }])[0].content)).selector,
    "#archive-project"
  );
});

test("a Claude refusal is an error, never an answer", async () => {
  const { client } = fakeClaude({
    content: [],
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: null, explanation: null }
  });

  await assert.rejects(
    askSpecialist(accessibleNameSpecialist, context, createClaudeModelProvider({ client })),
    /Claude declined/
  );
});

/** A reply as an OpenAI-compatible chat API (OpenAI, Ollama, LM Studio, vLLM) sends it. */
function chatCompletion(value: unknown) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_760_000_000,
    model: "tiny",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(value), refusal: null },
        logprobs: null,
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };
}

/** One text part of a Responses API message, holding a JSON answer. */
function outputText(value: unknown) {
  return { type: "output_text", text: JSON.stringify(value), annotations: [] };
}

/**
 * A reply as OpenAI's Responses API sends it over the wire, with these message parts. It has no
 * top-level `output_text`: the official SDK adds that field on the client, by joining the
 * message's `output_text` parts (`addOutputText` in the SDK's `lib/ResponsesParser`).
 */
function openAiResponse(...content: Array<Record<string, unknown>>) {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1_760_000_000,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "test-model",
    output: [{ type: "message", id: "msg_test", status: "completed", role: "assistant", content }],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "json_schema", name: "accessible_name_specialist", strict: true } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2
    },
    user: null,
    metadata: {}
  };
}

test("a local model is asked over the OpenAI-compatible chat API, held to the schema its prompt also carries, with thinking off and no OpenAI key", async () => {
  let authorization: string | undefined;
  let requestBody: {
    model?: string;
    reasoning_effort?: string;
    response_format?: unknown;
    messages?: [{ content: string }];
  } = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      requestBody = JSON.parse(body) as typeof requestBody;
      authorization = request.headers.authorization;
      assert.equal(request.url, "/v1/chat/completions");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(chatCompletion(answer)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // A key meant for OpenAI, which the SDK would otherwise read from the environment.
  const openAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "openai-only-key";
  try {
    const provider = createLocalModelProvider({
      // A trailing slash in the configured address is ignored.
      baseUrl: `http://127.0.0.1:${port}/v1/`,
      model: "tiny"
    });

    assert.deepEqual(await askSpecialist(accessibleNameSpecialist, context, provider), answer);
    assert.equal(requestBody.model, "tiny");
    assert.equal(requestBody.reasoning_effort, "none");
    assert.deepEqual(requestBody.response_format, {
      type: "json_schema",
      json_schema: { name: "accessible_name_specialist", strict: true, schema }
    });
    assert.ok(requestBody.messages?.[0].content.includes(JSON.stringify(schema)));
    assert.equal(authorization, "Bearer local");
  } finally {
    if (openAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = openAiKey;
    server.close();
  }
});

test("OpenAI's Responses API gets a strict, named schema and store: false", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOpenAiResponsesModelProvider({
    apiKey: "test-key",
    model: "test-model",
    async fetch(_input, init) {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(openAiResponse(outputText(answer))), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.deepEqual(await askSpecialist(accessibleNameSpecialist, context, provider), answer);
  assert.equal(requestBody?.store, false);
  assert.deepEqual((requestBody?.text as { format: unknown }).format, {
    type: "json_schema",
    name: "accessible_name_specialist",
    strict: true,
    schema
  });
});

test("an OpenAI refusal is an error, never an answer", async () => {
  const provider = createOpenAiResponsesModelProvider({
    apiKey: "test-key",
    model: "test-model",
    async fetch() {
      return new Response(
        JSON.stringify(openAiResponse({ type: "refusal", refusal: "I can't help with that." })),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  await assert.rejects(
    askSpecialist(accessibleNameSpecialist, context, provider),
    /OpenAI declined to answer \(I can't help with that\.\)/
  );
});

test("a failed OpenAI request is retried before it is given up", async () => {
  const statuses = [503, 200];
  const provider = createOpenAiResponsesModelProvider({
    apiKey: "test-key",
    model: "test-model",
    async fetch() {
      const status = statuses.shift() ?? 500;
      return new Response(
        JSON.stringify(
          status === 200 ? openAiResponse(outputText(answer)) : { error: { message: "busy" } }
        ),
        // Told to retry at once, so the test does not wait out the SDK's back-off.
        { status, headers: { "Content-Type": "application/json", "retry-after-ms": "0" } }
      );
    }
  });

  assert.deepEqual(await askSpecialist(accessibleNameSpecialist, context, provider), answer);
  assert.deepEqual(statuses, []);
});

const screenshot = { mediaType: "image/png" as const, base64: "iVBORw0KGgo=" };
/** The answer once the screenshot is evidence: it may cite it. */
const seeingAnswer = { ...answer, citedEvidenceIds: ["screenshot", "nearbyHeading"] };

test("each provider sends the element's screenshot as an image beside the evidence", async () => {
  const { client, requests } = fakeClaude({
    content: [{ type: "text", text: JSON.stringify(seeingAnswer) }],
    stop_reason: "end_turn"
  });
  await askSpecialist(
    accessibleNameSpecialist,
    context,
    createClaudeModelProvider({ client }),
    screenshot
  );
  const [claudeContent] = requests[0]?.body.messages as [{ content: unknown[] }];
  assert.deepEqual(claudeContent.content[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: screenshot.base64 }
  });

  const bodies: Array<Record<string, unknown>> = [];
  const reply =
    (output: Record<string, unknown>) => async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(output), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
  await askSpecialist(
    accessibleNameSpecialist,
    context,
    createLocalModelProvider({
      model: "tiny",
      fetch: reply(chatCompletion(seeingAnswer))
    }),
    screenshot
  );
  const [, localUser] = bodies[0]?.messages as [unknown, { content: unknown[] }];
  assert.deepEqual(localUser.content[1], {
    type: "image_url",
    image_url: { url: `data:image/png;base64,${screenshot.base64}` }
  });

  await askSpecialist(
    accessibleNameSpecialist,
    context,
    createOpenAiResponsesModelProvider({
      apiKey: "test-key",
      model: "test-model",
      fetch: reply(openAiResponse(outputText(seeingAnswer)))
    }),
    screenshot
  );
  const [openAiUser] = bodies[1]?.input as [{ content: unknown[] }];
  assert.deepEqual(openAiUser.content[1], {
    type: "input_image",
    image_url: `data:image/png;base64,${screenshot.base64}`,
    detail: "auto"
  });
});

test("a model that cannot see images is asked again without one, and from then on", async () => {
  const sent: Array<{ image: boolean; input: Record<string, unknown> }> = [];
  const provider = createLocalModelProvider({
    model: "text-only",
    async fetch(_input, init) {
      const body = JSON.parse(String(init?.body)) as { messages: [unknown, { content: unknown }] };
      const user = body.messages[1].content;
      const image = Array.isArray(user);
      const text = image ? (user[0] as { text: string }).text : String(user);
      sent.push({ image, input: JSON.parse(text) as Record<string, unknown> });
      if (image) {
        return new Response('{"error":{"message":"model does not support image input"}}', {
          status: 400
        });
      }
      return new Response(JSON.stringify(chatCompletion(answer)), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.deepEqual(
    await askSpecialist(accessibleNameSpecialist, context, provider, screenshot),
    answer
  );
  await askSpecialist(accessibleNameSpecialist, context, provider, screenshot);
  // The evidence names the screenshot only when the image goes with it.
  assert.deepEqual(
    sent.map(({ image, input }) => [image, "screenshot" in input]),
    [
      [true, true],
      [false, false],
      [false, false]
    ]
  );
});

// Live runs: each is skipped unless its model is reachable, so CI and offline builds stay green.
test("live: a local model names an icon-only button", async (t) => {
  const baseUrl = process.env.AEE_LLM_BASE_URL ?? DEFAULT_LOCAL_BASE_URL;
  const reachable = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) }).then(
    (response) => response.ok,
    () => false
  );
  if (!reachable) {
    t.skip(`no local model server at ${baseUrl}`);
    return;
  }

  const fix = await proposeAccessibleLabelFix(context, createModelProvider({ provider: "local" }));
  assert.match(fix.patches?.[0] ?? "", /aria-label="[^"]+"/);
});

test("live: Claude names an icon-only button", async (t) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    t.skip("ANTHROPIC_API_KEY is not set");
    return;
  }

  const fix = await proposeAccessibleLabelFix(context, createModelProvider({ provider: "claude" }));
  assert.match(fix.patches?.[0] ?? "", /aria-label="[^"]+"/);
});

test("live: OpenAI names an icon-only button", async (t) => {
  if (!process.env.OPENAI_API_KEY || !process.env.AEE_LLM_MODEL) {
    t.skip("OPENAI_API_KEY and AEE_LLM_MODEL are not both set");
    return;
  }

  const fix = await proposeAccessibleLabelFix(context, createModelProvider({ provider: "openai" }));
  assert.match(fix.patches?.[0] ?? "", /aria-label="[^"]+"/);
});
