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

test("a local model is asked over the OpenAI-compatible chat API, held to the schema its prompt also carries, with thinking off", async () => {
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
      assert.equal(request.url, "/v1/chat/completions");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
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
  } finally {
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
      return new Response(JSON.stringify({ output_text: JSON.stringify(answer) }), {
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
