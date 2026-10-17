import {
  capturePageDom,
  domNodeOf,
  fetchAccessibilityTree,
  type AccessibilityNode,
  type CapturedElement,
  type PageSessions
} from "./accessibility-tree";

/** A line of text styled like a heading that the accessibility tree does not expose as one. */
export interface HeadingLookalike {
  /** Where it is in the document that holds it. */
  selector: string;
  /** Inside a frame: the `<iframe>` elements it is inside, outermost first. */
  framePath?: string[];
  text: string;
  fontSize: number;
  fontWeight: number;
  bodyFontSize: number;
  bodyFontWeight: number;
}

/**
 * When text reads as a title, measured against the page's body text: bold and larger, or 40%
 * larger at any weight (axe-core's p-as-heading size margin). Bold at body size alone is not
 * enough: table values, card labels and inline emphasis use it too, so telling those from a title
 * needs context, which is the heading-structure specialist's job.
 */
const TITLE_MARGINS = [
  { size: 1.05, weight: 150 },
  { size: 1.4, weight: -Infinity }
];

/** Longer than this, larger text is a lead paragraph, not a title. */
const MAX_TITLE_LENGTH = 80;

/**
 * Text under these roles already says what it is: a heading, a table header, a term or definition,
 * a caption, a legend or a field label.
 */
const TEXT_ROLES = new Set([
  "heading",
  "columnheader",
  "rowheader",
  "term",
  "definition",
  "Caption",
  "Figcaption",
  "Legend",
  "LabelText"
]);

/**
 * Text that is a control's whole name is that control's label. A title line inside a control with
 * more text, such as a milestone title between its number and its count in a summary (Chromium's
 * DisclosureTriangle), still captions a section, and a heading there is lost because a button's
 * content is flattened into its name.
 */
const CONTROL_ROLES = new Set([
  "button",
  "DisclosureTriangle",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem"
]);

/**
 * Compares two pillars: how text looks (computed font size and weight, from a DOM snapshot) and
 * what assistive technology gets (the browser's accessibility tree). A standalone line styled as
 * a title with no heading in its accessibility-tree ancestry cannot be reached with a screen
 * reader's heading key. Every frame is read; body text is measured across the whole page.
 */
export async function findHeadingLookalikes(page: PageSessions): Promise<HeadingLookalike[]> {
  const [tree, dom] = await Promise.all([
    fetchAccessibilityTree(page),
    capturePageDom(page, ["font-size", "font-weight", "display"])
  ]);
  // Node ids repeat across frames rendered in different processes, so each is kept with its frame.
  const key = (frameId: string | undefined, nodeId: string) => `${frameId}\u0000${nodeId}`;
  const parent = new Map<string, AccessibilityNode>();
  for (const node of tree.nodes) {
    for (const child of node.childIds ?? []) parent.set(key(node.frameId, child), node);
  }
  const parentOf = (node: AccessibilityNode) => parent.get(key(node.frameId, node.nodeId));
  const roleOf = (node: AccessibilityNode) => String(node.role?.value ?? "");

  const runs = tree.nodes.flatMap((node) => {
    const text = typeof node.name?.value === "string" ? node.name.value.trim() : "";
    if (node.ignored || roleOf(node) !== "StaticText" || !text) return [];
    const ref = domNodeOf(node);
    const elements = ref ? dom.ancestorElements(ref) : [];
    const fontSize = Number.parseFloat(elements[0]?.style["font-size"] ?? "");
    const fontWeight = Number.parseFloat(elements[0]?.style["font-weight"] ?? "");
    const line = elements.find(({ style }) => isOwnLine(style.display));
    if (!line || !(fontSize > 0) || !(fontWeight > 0)) return [];
    let inTextRole = false;
    let control: AccessibilityNode | undefined;
    for (let above = parentOf(node); above; above = parentOf(above)) {
      inTextRole ||= TEXT_ROLES.has(roleOf(above));
      if (!control && CONTROL_ROLES.has(roleOf(above))) control = above;
    }
    return [{ text, fontSize, fontWeight, line, inTextRole, control }];
  });
  const bodyFontSize = weightedMedian(runs.map((run) => [run.fontSize, run.text.length]));
  const bodyFontWeight = weightedMedian(runs.map((run) => [run.fontWeight, run.text.length]));
  const looksLikeTitle = (run: (typeof runs)[number]) =>
    TITLE_MARGINS.some(
      ({ size, weight }) =>
        run.fontSize >= bodyFontSize * size && run.fontWeight - bodyFontWeight >= weight
    );
  const controlLines = new Map<AccessibilityNode, Set<CapturedElement>>();
  for (const { control, line } of runs) {
    if (control) controlLines.set(control, (controlLines.get(control) ?? new Set()).add(line));
  }
  const isControlName = (run: (typeof runs)[number]) =>
    run.control !== undefined && controlLines.get(run.control)!.size === 1;

  const lines = new Map<CapturedElement, typeof runs>();
  for (const run of runs) lines.set(run.line, [...(lines.get(run.line) ?? []), run]);
  return [...lines].flatMap(([line, lineRuns]) => {
    const text = lineRuns.map((run) => run.text).join(" ");
    const shown = (line.visualBounds?.width ?? 0) > 1 && (line.visualBounds?.height ?? 0) > 1;
    const title = lineRuns[0]!;
    return shown &&
      text.length <= MAX_TITLE_LENGTH &&
      /\p{L}/u.test(text) &&
      lineRuns.every(looksLikeTitle) &&
      !lineRuns.some((run) => run.inTextRole || isControlName(run))
      ? [
          {
            selector: line.nodePath,
            ...(line.framePath.length ? { framePath: line.framePath } : {}),
            text,
            fontSize: title.fontSize,
            fontWeight: title.fontWeight,
            bodyFontSize,
            bodyFontWeight
          }
        ]
      : [];
  });
}

/** A box that starts its own line: anything but an inline box, or a box with no box at all. */
function isOwnLine(display: string | undefined): boolean {
  return Boolean(display) && !display!.startsWith("inline") && display !== "contents";
}

/** The value in the middle of the page's text, counting each value once per character. */
function weightedMedian(values: Array<[number, number]>): number {
  const sorted = [...values].sort(([left], [right]) => left - right);
  let remaining = sorted.reduce((total, [, weight]) => total + weight, 0) / 2;
  for (const [value, weight] of sorted) {
    remaining -= weight;
    if (remaining <= 0) return value;
  }
  return 0;
}
