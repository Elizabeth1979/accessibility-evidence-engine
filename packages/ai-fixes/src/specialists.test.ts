import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  accessibleNameSpecialist,
  askSpecialist,
  imagePurposeSpecialist,
  imageRoleFromMarkup,
  proposeImageAlternativeFix,
  SPECIALISTS,
  type ImagePurposeContext,
  type ModelProvider,
  type ModelRequest
} from "./index";

/** The remediation registry, read as a file: the AI package does not depend on @aee/schemas. */
const registry = JSON.parse(
  readFileSync(path.join(__dirname, "../../schemas/json/remediation-registry.json"), "utf8")
) as { entries: Array<{ id: string; ai: { specialistId?: string; outputs: string[] } }> };

test("each specialist is allowlisted in the registry and answers with exactly its outputs", () => {
  for (const specialist of SPECIALISTS) {
    const entry = registry.entries.find(({ ai }) => ai.specialistId === specialist.id);
    assert.ok(entry, `${specialist.id} is not allowlisted in the registry.`);
    assert.deepEqual(specialist.schema.required.sort(), [...entry.ai.outputs].sort());
  }
});

test("every specialist runs with the accessibility-engineer prompt first", async () => {
  const prompt = readFileSync(
    path.join(__dirname, "../prompts/accessibility-engineer.md"),
    "utf8"
  ).trim();
  for (const specialist of SPECIALISTS) {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "recorder",
      async ask(request) {
        requests.push(request);
        throw new Error("recorded");
      }
    };
    await assert.rejects(askSpecialist(specialist, { selector: "#x" }, provider), /recorded/);
    assert.ok(requests[0]?.instructions.startsWith(prompt), `${specialist.id} ran without it.`);
    assert.ok(requests[0]?.instructions.endsWith(specialist.instructions));
  }
});

const iconContext = {
  selector: "#archive-project",
  role: "button",
  iconDescription: "an SVG icon with no title",
  nearbyHeading: "Project Alpha"
};

test("an accessible name must say what the control does and cite evidence it was given", () => {
  const parse = (answer: Record<string, unknown>) =>
    accessibleNameSpecialist.parse(
      {
        suggestedName: "Archive Project Alpha",
        rationale: "The control sits in the Project Alpha row.",
        confidence: 0.8,
        citedEvidenceIds: ["nearbyHeading"],
        ...answer
      },
      iconContext
    );

  assert.equal(parse({}).suggestedName, "Archive Project Alpha");
  assert.throws(() => parse({ suggestedName: "Button" }), /names the role/);
  assert.throws(() => parse({ suggestedName: "x".repeat(121) }), /1 to 120 characters/);
  assert.throws(() => parse({ citedEvidenceIds: [] }), /must name the evidence/);
  assert.throws(
    () => parse({ citedEvidenceIds: ["destinationText"] }),
    /not given: destinationText/
  );
  // A small local model once cited the selector itself, not the field that holds it.
  assert.throws(
    () => parse({ citedEvidenceIds: ["#archive-project"] }),
    /not given: #archive-project/
  );
  assert.throws(() => parse({ confidence: 2 }), /between 0 and 1/);
});

test("a request lets an answer cite only the fields its input holds", async () => {
  // An empty field holds no evidence, so it cannot be cited either.
  const input = { ...iconContext, nearbyText: " " };
  for (const specialist of SPECIALISTS) {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "recorder",
      async ask(request) {
        requests.push(request);
        throw new Error("recorded");
      }
    };
    await assert.rejects(askSpecialist(specialist, input, provider), /recorded/);
    assert.deepEqual(requests[0]?.schema.properties.citedEvidenceIds, {
      type: "array",
      items: { type: "string", enum: ["selector", "role", "iconDescription", "nearbyHeading"] }
    });
  }
});

test("the markup decides an image's role only when it says so", () => {
  assert.equal(imageRoleFromMarkup({ soleContentOfLinkOrButton: true, alt: "" }), "functional");
  assert.equal(imageRoleFromMarkup({ ariaHidden: true }), "decorative");
  assert.equal(imageRoleFromMarkup({ role: "presentation" }), "decorative");
  assert.equal(imageRoleFromMarkup({ alt: "" }), "decorative");
  // A missing alt is the defect, not a sign the image is decorative.
  assert.equal(imageRoleFromMarkup({}), undefined);
});

const chartContext: ImagePurposeContext = {
  selector: "#usage-chart",
  source: "https://example.test/img/usage-chart.svg",
  nearbyHeading: "Usage",
  nearbyText: "Requests per day this month"
};

test("an image answer keeps the markup's role and a real alternative", () => {
  const parse = (answer: Record<string, unknown>, context = chartContext) =>
    imagePurposeSpecialist.parse(
      {
        classification: "complex",
        suggestedAlternative: "Bar chart of requests per day this month",
        rationale: "A chart; its numbers need a table next to it.",
        confidence: 0.7,
        citedEvidenceIds: ["nearbyText"],
        ...answer
      },
      context
    );

  assert.equal(parse({}).classification, "complex");
  assert.equal(
    parse({ classification: "decorative", suggestedAlternative: "" }).classification,
    "decorative"
  );
  assert.throws(() => parse({ classification: "decorative" }), /empty alternative/);
  assert.throws(() => parse({ suggestedAlternative: "" }), /1 to 150 characters/);
  assert.throws(() => parse({ suggestedAlternative: "Image of a chart" }), /saying it is an image/);
  assert.throws(() => parse({ suggestedAlternative: "usage-chart.svg" }), /not a text alternative/);
  assert.throws(() => parse({ classification: "logo" }), /must be one of/);
  assert.throws(
    () => parse({}, { ...chartContext, markupRole: "functional" }),
    /makes this image functional; the answer said complex/
  );
});

test("an image alternative is proposed for review, never applied", async () => {
  const provider: ModelProvider = {
    id: "test-model",
    async ask() {
      return {
        classification: "complex",
        suggestedAlternative: "Bar chart of requests per day this month",
        rationale: "A chart; its numbers need a table next to it.",
        confidence: 0.7,
        citedEvidenceIds: ["nearbyText"]
      };
    }
  };

  const fix = await proposeImageAlternativeFix(chartContext, provider);

  assert.equal(fix.safety, "review");
  assert.equal(fix.answer.classification, "complex");
  assert.deepEqual(fix.patches, [
    '#usage-chart: set alt="Bar chart of requests per day this month"'
  ]);
  await assert.rejects(
    proposeImageAlternativeFix({ selector: "#logo", markupRole: "decorative" }, provider),
    /already marks the image decorative/
  );
});
