import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ImageInputUnsupportedError,
  type AnswerSchema,
  type ModelImage,
  type ModelProvider
} from "./model-providers";

/**
 * The accessibility-engineer prompt: the method every specialist works by. It ships in the
 * package's prompts/ folder, and askSpecialist puts it first in every request.
 */
export const ACCESSIBILITY_ENGINEER_PROMPT = readFileSync(
  path.join(__dirname, "../prompts/accessibility-engineer.md"),
  "utf8"
).trim();

/**
 * An allowlisted AI task. Its id is the registry's specialistId and its answer fields are that
 * registry entry's outputs, so the registry stays the one allowlist. It sees evidence only.
 */
export interface Specialist<Input extends object, Answer> {
  id: string;
  instructions: string;
  schema: AnswerSchema;
  /** Checks a model's answer against the evidence it was given; throws on anything unfounded. */
  parse(value: unknown, input: Input): Answer;
}

/** The evidence that stands for an attached screenshot, so an answer can cite it. */
export const ATTACHED_SCREENSHOT = "The attached image: the element as the page showed it.";

/** Providers whose model said it cannot see images: each is asked without them from then on. */
const blindProviders = new WeakSet<ModelProvider>();

/**
 * Asks the provider on the specialist's behalf and returns the checked answer. The request's
 * instructions are the accessibility-engineer prompt, then the specialist's own task. A
 * screenshot, when given, goes with the evidence as an image; a model that cannot see images is
 * asked again without it, and its answer then rests on the page context alone.
 */
export async function askSpecialist<Input extends object, Answer>(
  specialist: Specialist<Input, Answer>,
  input: Input,
  provider: ModelProvider,
  screenshot?: ModelImage
): Promise<Answer> {
  const seen = screenshot && !blindProviders.has(provider) ? screenshot : undefined;
  const evidence = seen ? { ...input, screenshot: ATTACHED_SCREENSHOT } : input;
  try {
    const value = await provider.ask({
      name: specialist.id.replaceAll("-", "_"),
      instructions: `${ACCESSIBILITY_ENGINEER_PROMPT}\n\n## This request\n\nThis request is one narrow step of the method above. Answer only with the JSON object its schema asks for; the finding card and coverage format do not apply to it.\n\n${specialist.instructions}`,
      input: evidence,
      schema: citingOnly(specialist.schema, evidenceFields(evidence)),
      ...(seen ? { image: seen } : {})
    });
    return specialist.parse(value, evidence);
  } catch (error) {
    if (!(seen && error instanceof ImageInputUnsupportedError)) throw error;
    blindProviders.add(provider);
    return askSpecialist(specialist, input, provider);
  }
}

/** The input fields that hold evidence: the only names an answer may cite. */
function evidenceFields(input: object): string[] {
  return Object.entries(input)
    .filter(([, evidence]) => typeof evidence === "string" && evidence.trim())
    .map(([id]) => id);
}

/**
 * The answer's schema, with its citations limited to the fields this input holds. A runtime that
 * enforces the schema then cannot cite anything else, such as an element's selector in place of
 * the field that holds it.
 */
function citingOnly(schema: AnswerSchema, fields: string[]): AnswerSchema {
  return {
    ...schema,
    properties: {
      ...schema.properties,
      citedEvidenceIds: { type: "array", items: { type: "string", enum: fields } }
    }
  };
}

/** The picture a naming or alt-text question gets: the element alone, as its context is text. */
const CLOSE_CROP =
  "A screenshot, when attached, is the element itself cut close to its edges; the page around it is in the other fields.";

// Ported from accessibility-engine's judge prompt: quality in context, grounded in evidence only.
const GROUNDING = [
  "Judge quality in context, not mere presence: a name or text alternative can exist and still be wrong, generic ('image', 'button'), redundant ('image of…') or meaningless for what the element does.",
  "Ground every answer only in the evidence provided. Do not invent details about the image, page or element that the evidence does not state.",
  "citedEvidenceIds lists the names of the input fields your answer relies on. When the evidence is not enough, say so in the rationale and give a low confidence; never guess.",
  "When the input has a screenshot field, an image is attached: the element as the page showed it. Use what it shows, read any words in it, and cite screenshot. Without one, you have the page's text only: say so in the rationale."
].join("\n");

export interface AccessibleLabelContext {
  selector: string;
  role: string;
  currentAccessibleName?: string;
  iconDescription?: string;
  nearbyHeading?: string;
  nearbyText?: string;
  destinationText?: string;
}

export interface AccessibleNameAnswer {
  suggestedName: string;
  rationale: string;
  confidence: number;
  citedEvidenceIds: string[];
}

/** Names an icon-only control from the UI around it. The registry allowlists it for accessible-name. */
export const accessibleNameSpecialist: Specialist<AccessibleLabelContext, AccessibleNameAnswer> = {
  id: "accessible-name-specialist",
  instructions: [
    "Suggest an accessible name for an icon-only control that has none.",
    GROUNDING,
    CLOSE_CROP,
    "The name must describe what the control does in this context: 'Open cart drawer', not 'button'. Keep it short, start with a verb when the control acts, name the object it acts on when the context gives one, and leave out the role ('button', 'link')."
  ].join("\n"),
  schema: answerSchema({
    suggestedName: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "number" },
    citedEvidenceIds: { type: "array", items: { type: "string" } }
  }),
  parse(value, input) {
    const answer = readRecord(value, "accessible-name answer");
    const suggestedName = readText(answer.suggestedName, "suggestedName", 120);
    if (GENERIC_NAMES.has(suggestedName.toLowerCase())) {
      throw new Error(`"${suggestedName}" names the role, not what the control does.`);
    }
    return {
      suggestedName,
      rationale: readText(answer.rationale, "rationale", 500),
      confidence: readConfidence(answer.confidence),
      citedEvidenceIds: readCitations(answer.citedEvidenceIds, input)
    };
  }
};

/** The image roles of the W3C alt decision tree. */
export type ImageRole = "decorative" | "informative" | "functional" | "complex";

export const IMAGE_ROLES: readonly ImageRole[] = [
  "decorative",
  "informative",
  "functional",
  "complex"
];

export interface ImageMarkup {
  role?: string;
  ariaHidden?: boolean;
  /** undefined when the attribute is missing; "" is the author marking it decorative. */
  alt?: string;
  /** The image is the only content of a link or button, so it names that control. */
  soleContentOfLinkOrButton?: boolean;
}

/**
 * The role the markup itself decides, before any AI (ported from wcag-alt-generator). A missing
 * alt decides nothing: that is the defect, not a sign the image is decorative.
 */
export function imageRoleFromMarkup(markup: ImageMarkup): ImageRole | undefined {
  if (markup.soleContentOfLinkOrButton) return "functional";
  if (markup.role === "presentation" || markup.role === "none" || markup.ariaHidden) {
    return "decorative";
  }
  if (markup.alt === "") return "decorative";
  return undefined;
}

export interface ImagePurposeContext {
  selector: string;
  /** The image's file name or URL: evidence, never the alternative itself. */
  source?: string;
  currentAlternative?: string;
  /** The role the markup already decides (imageRoleFromMarkup); the answer must keep it. */
  markupRole?: ImageRole;
  linkOrButtonText?: string;
  destinationText?: string;
  caption?: string;
  title?: string;
  nearbyHeading?: string;
  nearbyText?: string;
}

export interface ImagePurposeAnswer {
  classification: ImageRole;
  /** Empty exactly when the image is decorative. */
  suggestedAlternative: string;
  rationale: string;
  confidence: number;
  citedEvidenceIds: string[];
}

/**
 * Classifies an image and drafts its alternative from page context. The rules come from
 * wcag-alt-generator and alt-generation-claude, the grounding from accessibility-engine.
 */
export const imagePurposeSpecialist: Specialist<ImagePurposeContext, ImagePurposeAnswer> = {
  id: "image-purpose-specialist",
  instructions: [
    "Classify an image's purpose, then draft its text alternative from the page context.",
    GROUNDING,
    CLOSE_CROP,
    "Classify it as one of:",
    "- decorative: it adds nothing the page does not already say; its alternative is empty.",
    "- functional: it is inside a link or button; the alternative describes the action or destination, not the picture.",
    "- informative: it conveys a simple piece of information; the alternative says what it communicates in this context, in a short phrase.",
    "- complex: a chart, diagram or map whose content a phrase cannot carry; the alternative names what it shows, and the rationale says a longer description is needed next to it.",
    "When markupRole is given, the markup has already decided the role: keep it.",
    "If the image contains text, the alternative includes that text. Keep it under 125 characters, do not repeat what the surrounding text already says, and never start with 'image of' or 'picture of'. 'image', 'photo' or a file name is not an alternative."
  ].join("\n"),
  schema: answerSchema({
    classification: { type: "string", enum: [...IMAGE_ROLES] },
    suggestedAlternative: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "number" },
    citedEvidenceIds: { type: "array", items: { type: "string" } }
  }),
  parse(value, input) {
    const answer = readRecord(value, "image-purpose answer");
    const classification = answer.classification;
    if (!IMAGE_ROLES.includes(classification as ImageRole)) {
      throw new Error(`classification must be one of ${IMAGE_ROLES.join(", ")}.`);
    }
    const role = classification as ImageRole;
    if (input.markupRole && role !== input.markupRole) {
      throw new Error(`The markup makes this image ${input.markupRole}; the answer said ${role}.`);
    }
    const suggestedAlternative =
      typeof answer.suggestedAlternative === "string" ? answer.suggestedAlternative.trim() : "";
    if (role === "decorative" && suggestedAlternative) {
      throw new Error("A decorative image has an empty alternative.");
    }
    if (role !== "decorative") {
      readText(suggestedAlternative, "suggestedAlternative", 150);
      if (/^(image|picture|photo|graphic) of\b/i.test(suggestedAlternative)) {
        throw new Error(`"${suggestedAlternative}" starts by saying it is an image.`);
      }
      if (
        GENERIC_NAMES.has(suggestedAlternative.toLowerCase()) ||
        suggestedAlternative === fileName(input.source)
      ) {
        throw new Error(`"${suggestedAlternative}" is not a text alternative.`);
      }
    }
    return {
      classification: role,
      suggestedAlternative,
      rationale: readText(answer.rationale, "rationale", 500),
      confidence: readConfidence(answer.confidence),
      citedEvidenceIds: readCitations(answer.citedEvidenceIds, input)
    };
  }
};

export interface ColorMeaningContext {
  selector: string;
  /** The item's text. */
  itemText: string;
  /** The sweep's finding: which colours differ from the item's like neighbours, and any state. */
  finding: string;
}

export interface ColorMeaningAnswer {
  colorCarriesMeaning: boolean;
  /** What the colour tells a person, in a few words; empty when it tells nothing. */
  meaning: string;
  rationale: string;
  confidence: number;
  citedEvidenceIds: string[];
}

/** Says whether a colour-only difference carries information, from the row as the page showed it. */
export const colorMeaningSpecialist: Specialist<ColorMeaningContext, ColorMeaningAnswer> = {
  id: "color-meaning-specialist",
  instructions: [
    "One item in a row of like items differs from its neighbours in colour only; finding says which colours. The screenshot shows the row with the item outlined in magenta.",
    GROUNDING,
    "Say whether the colour tells a person something they need, such as a state (the current page, a selected item, an error, a required field, over a limit) or a status, and name it in a few words. If it is decoration or emphasis that tells nothing, colorCarriesMeaning is false and meaning is empty.",
    "Do not judge contrast or suggest colours: only whether the colour carries information that a person who cannot see it would miss."
  ].join("\n"),
  schema: answerSchema({
    colorCarriesMeaning: { type: "boolean" },
    meaning: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "number" },
    citedEvidenceIds: { type: "array", items: { type: "string" } }
  }),
  parse(value, input) {
    const answer = readRecord(value, "colour-meaning answer");
    const colorCarriesMeaning = readBoolean(answer.colorCarriesMeaning, "colorCarriesMeaning");
    const meaning = typeof answer.meaning === "string" ? answer.meaning.trim() : "";
    if (colorCarriesMeaning) readText(meaning, "meaning", 80);
    else if (meaning) throw new Error("A colour that tells nothing has an empty meaning.");
    return {
      colorCarriesMeaning,
      meaning,
      rationale: readText(answer.rationale, "rationale", 500),
      confidence: readConfidence(answer.confidence),
      citedEvidenceIds: readCitations(answer.citedEvidenceIds, input)
    };
  }
};

export interface TextImageContext {
  selector: string;
  currentAlternative: string;
  /** The sweep's finding: why the image may be words drawn as pixels. */
  finding: string;
}

export interface TextImageAnswer {
  showsText: boolean;
  /** The words the image shows, as written; empty when it shows none. */
  text: string;
  /** A logo or wordmark, which WCAG 1.4.5 exempts. */
  isLogo: boolean;
  rationale: string;
  confidence: number;
  citedEvidenceIds: string[];
}

/** Reads the words an image shows, if any, from the image as the page showed it. */
export const textImageSpecialist: Specialist<TextImageContext, TextImageAnswer> = {
  id: "text-image-specialist",
  instructions: [
    "The screenshot shows an image cut close to its edges. Say whether it shows words drawn as pixels, and write them exactly as shown. Say whether it is a logo or wordmark, which WCAG exempts.",
    GROUNDING,
    "Labels inside a chart, diagram, map or photograph are part of the picture: showsText is false for them. When showsText is false, text is empty."
  ].join("\n"),
  schema: answerSchema({
    showsText: { type: "boolean" },
    text: { type: "string" },
    isLogo: { type: "boolean" },
    rationale: { type: "string" },
    confidence: { type: "number" },
    citedEvidenceIds: { type: "array", items: { type: "string" } }
  }),
  parse(value, input) {
    const answer = readRecord(value, "text-image answer");
    const showsText = readBoolean(answer.showsText, "showsText");
    const text = typeof answer.text === "string" ? answer.text.trim() : "";
    if (showsText) readText(text, "text", 300);
    else if (text) throw new Error("An image that shows no words has empty text.");
    return {
      showsText,
      text,
      isLogo: readBoolean(answer.isLogo, "isLogo"),
      rationale: readText(answer.rationale, "rationale", 500),
      confidence: readConfidence(answer.confidence),
      citedEvidenceIds: readCitations(answer.citedEvidenceIds, input)
    };
  }
};

const GENERIC_NAMES = new Set(["button", "link", "icon", "image", "photo", "picture", "graphic"]);

function answerSchema(properties: Record<string, unknown>): AnswerSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties)
  };
}

function readRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown, field: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    throw new Error(`${field} must be 1 to ${maximum} characters.`);
  }
  return text;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be true or false.`);
  return value;
}

function readConfidence(value: unknown): number {
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new Error("confidence must be between 0 and 1.");
  }
  return value;
}

/** Every cited id must name an input field that holds evidence: an answer cannot cite nothing. */
function readCitations(value: unknown, input: object): string[] {
  const available = evidenceFields(input);
  const cited = Array.isArray(value) ? [...new Set(value)] : [];
  if (cited.length === 0) {
    throw new Error("citedEvidenceIds must name the evidence the answer relies on.");
  }
  const unfounded = cited.filter((id) => !available.includes(String(id)));
  if (unfounded.length > 0) {
    throw new Error(`citedEvidenceIds names evidence that was not given: ${unfounded.join(", ")}.`);
  }
  return cited.map(String);
}

function fileName(source: string | undefined): string | undefined {
  return source?.split(/[?#]/)[0]?.split("/").pop();
}

/** Every specialist the registry allowlists and this package implements. */
export const SPECIALISTS: ReadonlyArray<Specialist<{ selector: string }, unknown>> = [
  accessibleNameSpecialist,
  imagePurposeSpecialist,
  colorMeaningSpecialist,
  textImageSpecialist
];
