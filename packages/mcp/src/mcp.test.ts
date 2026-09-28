import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./index";

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const textOf = (result: unknown) =>
  (result as ToolResult).content.map(({ text = "" }) => text).join("\n");

async function connected(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

test("the server offers explain, findings and run, and nothing that applies a fix", async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), ["explain", "findings", "run"]);
  assert.equal(tools.find(({ name }) => name === "explain")?.annotations?.readOnlyHint, true);
  // Without these in its system prompt, an agent asked "explain button-name" answered from memory.
  assert.match(
    client.getInstructions() ?? "",
    /call `explain` and answer from the a11y-skills pattern/
  );
  await client.close();
});

test("findings on a folder with no assessment is an error that says how to make one", async () => {
  const client = await connected();
  const empty = await mkdtemp(path.join(os.tmpdir(), "aee-mcp-"));
  try {
    const result = (await client.callTool({
      name: "findings",
      arguments: { folder: empty }
    })) as ToolResult;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No AEE assessment was found under .*aee run/);
  } finally {
    await client.close();
    await rm(empty, { recursive: true, force: true });
  }
});

test("a coding agent that starts aee-mcp and asks to explain button-name gets the buttons pattern", async () => {
  const client = new Client({ name: "coding-agent", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, "bin.js")] })
  );
  try {
    const answer = textOf(
      await client.callTool({ name: "explain", arguments: { topic: "button-name" } })
    );
    assert.match(answer, /^# a11y-skills pattern: buttons\n/);
    assert.match(answer, /Requirements: WCAG 4\.1\.2 Name, Role, Value \(A\)\./);
    assert.match(answer, /patterns\/buttons\.instructions\.md/);
    assert.match(answer, /# Button and Clickable Element Accessibility/);
  } finally {
    await client.close();
  }
});
