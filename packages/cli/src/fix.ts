import { parse as parseJs } from "@babel/parser";
import { parse as parseHtml, type DefaultTreeAdapterMap } from "parse5";

/**
 * One reviewed change: set one attribute on one element. Ported from accessibility-engine's
 * `@aee/fix`, with a real HTML parser where it used a regular expression.
 */
export interface FixProposal {
  /** The element, as the report names it: an `#id` selector is the only kind located in source. */
  selector: string;
  attribute: FixAttribute;
  value: string;
}

/** The attributes a fix sets; a name that comes from text content or a label is left to a person. */
export type FixAttribute = "aria-label" | "alt";

/** The attribute that carries the accessible name each allowlisted axe rule asks for. */
const ATTRIBUTE_FOR_RULE: Record<string, FixAttribute> = {
  "button-name": "aria-label",
  "link-name": "aria-label",
  "image-alt": "alt",
  "input-image-alt": "alt",
  "role-img-alt": "aria-label",
  "svg-img-alt": "aria-label"
};

export function fixAttributeForRule(ruleId: string): FixAttribute | undefined {
  return ATTRIBUTE_FOR_RULE[ruleId];
}

export interface ApplyResult {
  applied: boolean;
  /** The edited source, or the source unchanged when nothing was applied. */
  source: string;
  /** What changed, or why nothing did and what a person should do instead. */
  detail: string;
}

/** The change in words, for a person applying it by hand. */
export function describeFix(proposal: FixProposal): string {
  return `set ${proposal.attribute}=${JSON.stringify(proposal.value)} on ${proposal.selector}`;
}

/** Where the attribute goes: a span of the source to replace, or why it cannot be placed. */
type Placement = { start: number; end: number; text: string } | { declined: string };

/**
 * Sets the attribute on the one element whose `id` the selector names, keeping every other byte of
 * the file. HTML goes through parse5, JavaScript and TSX through Babel with JSX on, so an element
 * is found by a real parse, never a text search. It declines, and changes nothing, when the file is
 * of another kind or does not parse, the selector is not an id, no element or more than one has the
 * id, or the attribute is an expression such as `aria-label={label}`, which only a person can
 * change safely. Pure: returns the new source and writes nothing.
 */
export function applyFix(proposal: FixProposal, source: string, fileName: string): ApplyResult {
  const decline = (reason: string): ApplyResult => ({
    applied: false,
    source,
    detail: `Not applied: ${reason}. Apply by hand: ${describeFix(proposal)}.`
  });
  const id = /^#[A-Za-z_][\w-]*$/.test(proposal.selector) ? proposal.selector.slice(1) : undefined;
  if (id === undefined) return decline("only an #id selector can be found in source");
  const escaped = proposal.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const attribute = `${proposal.attribute}="${escaped}"`;
  const placement = /\.html?$/i.test(fileName)
    ? placeInHtml(source, id, proposal.attribute, attribute)
    : /\.([cm]?js|jsx|tsx)$/i.test(fileName)
      ? placeInJsx(source, id, proposal.attribute, attribute, /\.tsx$/i.test(fileName))
      : { declined: `${fileName} is not an HTML, JavaScript, JSX or TSX file` };
  if ("declined" in placement) return decline(placement.declined);
  return {
    applied: true,
    source: source.slice(0, placement.start) + placement.text + source.slice(placement.end),
    detail: `Applied: ${describeFix(proposal)}.`
  };
}

function placeInHtml(source: string, id: string, name: string, attribute: string): Placement {
  const matches: HtmlElement[] = [];
  const visit = (node: HtmlNode) => {
    if ("attrs" in node && node.attrs.some((attr) => attr.name === "id" && attr.value === id)) {
      matches.push(node);
    }
    for (const child of "childNodes" in node ? node.childNodes : []) visit(child);
    if ("content" in node && node.content) visit(node.content);
  };
  visit(parseHtml(source, { sourceCodeLocationInfo: true }));
  if (matches.length !== 1) return { declined: noSingleMatch(matches.length, id) };
  const location = matches[0]!.sourceCodeLocation;
  const startTag = location?.startTag;
  if (!startTag) return { declined: `the element with id "${id}" has no start tag in the file` };
  const existing = location.attrs?.[name];
  if (existing) return { start: existing.startOffset, end: existing.endOffset, text: attribute };
  // After the last attribute, before the tag's closing `>` or `/>`.
  const tag = source.slice(startTag.startOffset, startTag.endOffset);
  const at = startTag.startOffset + tag.search(/\s*\/?>$/);
  return { start: at, end: at, text: ` ${attribute}` };
}

function placeInJsx(
  source: string,
  id: string,
  name: string,
  attribute: string,
  typescript: boolean
): Placement {
  let program: unknown;
  try {
    program = parseJs(source, {
      sourceType: "module",
      plugins: typescript ? ["jsx", "typescript"] : ["jsx"]
    }).program;
  } catch (error) {
    return { declined: `the file does not parse (${(error as Error).message})` };
  }
  const matches: JsxOpeningElement[] = [];
  walk(program, (node) => {
    if (node.type !== "JSXOpeningElement") return;
    const element = node as JsxOpeningElement;
    const idValue = jsxAttribute(element, "id")?.value;
    if (idValue?.type === "StringLiteral" && idValue.value === id) matches.push(element);
  });
  if (matches.length !== 1) return { declined: noSingleMatch(matches.length, id) };
  const element = matches[0]!;
  const existing = jsxAttribute(element, name);
  if (!existing) return { start: element.name.end, end: element.name.end, text: ` ${attribute}` };
  if (existing.value && existing.value.type !== "StringLiteral") {
    return { declined: `its ${name} is an expression, not a string` };
  }
  return { start: existing.start, end: existing.end, text: attribute };
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

interface JsxNode {
  type: string;
  start: number;
  end: number;
}
interface JsxAttribute extends JsxNode {
  name: JsxNode & { name?: unknown };
  value?: (JsxNode & { value?: unknown }) | null;
}
interface JsxOpeningElement extends JsxNode {
  name: JsxNode;
  attributes: JsxNode[];
}

/** Visits every AST node below `node`, depth first. */
function walk(node: unknown, visit: (node: JsxNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof (node as JsxNode).type === "string") visit(node as JsxNode);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "loc" && key !== "extra") walk(value, visit);
  }
}

function jsxAttribute(element: JsxOpeningElement, name: string): JsxAttribute | undefined {
  return element.attributes.find(
    (node): node is JsxAttribute =>
      node.type === "JSXAttribute" && (node as JsxAttribute).name.name === name
  );
}

function noSingleMatch(count: number, id: string): string {
  return count ? `${count} elements have id "${id}"` : `no element has id "${id}"`;
}
