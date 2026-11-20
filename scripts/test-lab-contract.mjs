// Reads site/test-lab-contract.json, the test lab's known answers, and refuses one that does not
// match its schema. Each error names the field, such as `/issues/2 is missing "family"`, so a
// case with a missing, misspelt or unknown field cannot be read as a case with no answer.
// The schema compiles in @aee/schemas' own Ajv, under the same strict options as AEE's schemas.
import { readFileSync } from "node:fs";
import path from "node:path";

import { createSchemaAjv } from "@aee/schemas";

// From the repository root, as every script and test runs; Playwright loads this file for the lab
// tests without `import.meta`.
const contractFile = path.resolve("site/test-lab-contract.json");
const schema = readJson(path.resolve("site/test-lab-contract.schema.json"));
const registry = readJson(path.resolve("packages/schemas/json/remediation-registry.json"));
const validate = createSchemaAjv().compile(schema);

/** Every way a contract breaks its schema or names a concept the registry does not have. */
export function contractErrors(contract) {
  // An `if` that fails reports the `then` beside it too; the `then` error names the field.
  if (!validate(contract)) {
    return validate.errors.filter(({ keyword }) => keyword !== "if").map(describe);
  }
  const concepts = new Set(registry.entries.map(({ id }) => id));
  return contract.issues.flatMap((issue, index) =>
    ["concept", "family"]
      .filter((field) => !concepts.has(issue[field]))
      .map(
        (field) =>
          `/issues/${index}/${field} "${issue[field]}" is not a concept in remediation-registry.json`
      )
  );
}

/** The contract, checked; throws naming every field that is wrong. */
export function loadTestLabContract(file = contractFile) {
  const contract = readJson(file);
  const errors = contractErrors(contract);
  if (errors.length > 0) {
    throw new Error(`Invalid ${path.basename(file)}: ${errors.join("; ")}`);
  }
  return contract;
}

/** An issue's own page: the fixed page with only that issue's mutation applied. */
export function issuePageUrl(contract, issue) {
  return contract.issuePage.urlTemplate.replace("{id}", encodeURIComponent(issue.id));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Ajv's own message, with the field it is about: Ajv keeps a missing or unknown property's name
// in `params`, not in the message.
function describe({ instancePath, keyword, message, params }) {
  const where = instancePath || "(root)";
  if (keyword === "required") return `${where} is missing "${params.missingProperty}"`;
  if (keyword === "additionalProperties") {
    return `${where} has unknown field "${params.additionalProperty}"`;
  }
  if (keyword === "enum") return `${where} must be one of ${params.allowedValues.join(", ")}`;
  if (keyword === "false schema") return `${where} is not allowed here`;
  if (keyword === "const") return `${where} must be ${JSON.stringify(params.allowedValue)}`;
  return `${where} ${message}`;
}
