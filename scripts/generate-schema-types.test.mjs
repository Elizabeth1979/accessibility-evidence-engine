// AEE's evidence types are generated from its schemas, so a type cannot say something its schema
// does not. These tests hold the committed types to the schemas and show that a schema change
// reaches the type it gives.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { generateSchemaTypes, schemaDir, typesFile } from "./generate-schema-types.mjs";

const copies = [];
after(() => copies.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

/** A copy of the schemas, with one schema changed. */
function schemasWith(file, change) {
  const directory = mkdtempSync(path.join(tmpdir(), "aee-schema-types-"));
  copies.push(directory);
  cpSync(schemaDir, directory, { recursive: true });
  const schema = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
  change(schema);
  writeFileSync(path.join(directory, file), JSON.stringify(schema));
  return directory;
}

/** The members of one generated interface, as written. */
function membersOf(types, name) {
  const start = types.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `${name} is not declared`);
  return types.slice(start, types.indexOf("\n}\n", start));
}

test("the committed types are the ones the schemas give", async () => {
  assert.equal(
    readFileSync(typesFile, "utf8"),
    await generateSchemaTypes(),
    "packages/schemas/src/schema-types.ts is stale: run npm run build."
  );
});

test("a transcript's live-region announcements are optional, as its schema says", async () => {
  const transcript = membersOf(await generateSchemaTypes(), "VirtualScreenReaderTranscript");
  assert.match(transcript, /\n {2}liveRegionAnnouncements\?: LiveRegionAnnouncement\[\];/);
});

test("a schema change reaches the type it gives", async () => {
  const directory = schemasWith("virtual-screen-reader-transcript.schema.json", (schema) => {
    schema.required.push("liveRegionAnnouncements");
  });
  const transcript = membersOf(
    await generateSchemaTypes(directory),
    "VirtualScreenReaderTranscript"
  );
  assert.match(transcript, /\n {2}liveRegionAnnouncements: LiveRegionAnnouncement\[\];/);
});

test("a definition the generator has no name for fails the run, naming it", async () => {
  const directory = schemasWith("common.schema.json", (schema) => {
    schema.$defs.unnamed = { type: "string" };
  });
  await assert.rejects(
    generateSchemaTypes(directory),
    /Name the type of common\.schema\.json#\/\$defs\/unnamed in scripts\/generate-schema-types\.mjs\./
  );
});

test("a reference outside AEE's schemas fails the run, rather than being fetched", async () => {
  const directory = schemasWith("finding.schema.json", (schema) => {
    schema.properties.ruleId = { $ref: "https://example.test/rule.schema.json" };
  });
  await assert.rejects(
    generateSchemaTypes(directory),
    /No AEE schema has the \$id https:\/\/example\.test\/rule\.schema\.json/
  );
});
