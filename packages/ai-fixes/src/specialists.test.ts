import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  accessibleNameSpecialist,
  askSpecialist,
  colorMeaningSpecialist,
  imagePurposeSpecialist,
  imageRoleFromMarkup,
  judgeColorMeaning,
  proposeImageAlternativeFix,
  SPECIALISTS,
  textImageSpecialist,
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
  nearbyHeading: "Requests per day",
  nearbyText: "Usage resets on the first day of each month. Seats: 5 of 5"
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
  // The free model's first lab answer: the hint beside the chart, not what the chart shows.
  assert.throws(
    () =>
      parse({
        suggestedAlternative:
          "Usage chart showing daily usage for Mon-Fri. Usage resets on the first day of each month."
      }),
    /repeats "Usage resets on the first day of each month\." from beside the image/
  );
  assert.throws(
    () =>
      parse(
        { suggestedAlternative: "Plan usage: Storage: 12 of 10 GB" },
        { ...chartContext, nearbyText: "Seats: 5 of 5\nStorage: 12 of 10 GB" }
      ),
    /repeats "Storage: 12 of 10 GB"/
  );
  // Sharing a word or two with the heading is not repeating it.
  assert.equal(
    parse({ suggestedAlternative: "Line chart of requests per day, Monday to Friday" })
      .suggestedAlternative,
    "Line chart of requests per day, Monday to Friday"
  );
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

const overLimit = {
  selector: "#storage-limit",
  itemText: "Storage: 12 of 10 GB",
  finding: "Stands out from its 2 neighbours by colour alone (color: rgb(255, 141, 141))."
};
/** The evidence as a model with the screenshot gets it, which an answer may cite. */
const seen = { screenshot: "The attached image: the element as the page showed it." };

test("a colour's meaning is named when it has one, and empty when it has none", () => {
  const parse = (answer: Record<string, unknown>) =>
    colorMeaningSpecialist.parse(
      {
        colorCarriesMeaning: true,
        meaning: "Over the storage limit",
        rationale: "Red marks the one limit that is exceeded.",
        confidence: 0.8,
        citedEvidenceIds: ["screenshot", "itemText"],
        ...answer
      },
      { ...overLimit, ...seen }
    );

  assert.equal(parse({}).meaning, "Over the storage limit");
  assert.equal(parse({ colorCarriesMeaning: false, meaning: "" }).colorCarriesMeaning, false);
  assert.throws(() => parse({ meaning: "" }), /meaning must be 1 to 80/);
  assert.throws(() => parse({ colorCarriesMeaning: false }), /tells nothing has an empty meaning/);
  assert.throws(() => parse({ colorCarriesMeaning: "yes" }), /must be true or false/);
});

test("an image's words are read when it shows some, and a logo is said to be one", () => {
  const banner = {
    selector: "#upgrade-banner",
    currentAlternative: "Upgrade to Team for unlimited projects",
    finding: "An image shaped like a line of text, drawn in two flat colours.",
    ...seen
  };
  const parse = (answer: Record<string, unknown>) =>
    textImageSpecialist.parse(
      {
        showsText: true,
        text: "Upgrade to Team for unlimited projects",
        isLogo: false,
        rationale: "The banner is one line of white words on green.",
        confidence: 0.9,
        citedEvidenceIds: ["screenshot"],
        ...answer
      },
      banner
    );

  assert.equal(parse({}).text, "Upgrade to Team for unlimited projects");
  assert.equal(parse({ showsText: false, text: "" }).showsText, false);
  assert.equal(parse({ isLogo: true }).isLogo, true);
  assert.throws(() => parse({ text: "" }), /text must be 1 to 300/);
  assert.throws(() => parse({ showsText: false }), /shows no words has empty text/);
});

test("a colour is judged only from a screenshot: without one, no model is asked", async () => {
  const asked: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "test-model",
    async ask(request) {
      asked.push(request);
      return {};
    }
  };
  await assert.rejects(judgeColorMeaning(overLimit, provider), /no screenshot of the element/i);
  assert.equal(asked.length, 0);
});
