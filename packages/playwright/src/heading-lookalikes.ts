import {
  capturePageDom,
  fetchAccessibilityTree,
  type AccessibilityNode,
  type CapturedElement,
  type CdpSession
} from "./accessibility-tree";

/** A line of text styled like a heading that the accessibility tree does not expose as one. */
export interface HeadingLookalike {
  selector: string;
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
 * reader's heading key.
 */
export async function findHeadingLookalikes(session: CdpSession): Promise<HeadingLookalike[]> {
  const [tree, dom] = await Promise.all([
    fetchAccessibilityTree(session),
    capturePageDom(session, ["font-size", "font-weight", "display"])
  ]);
  const parent = new Map<string, AccessibilityNode>();
  for (const node of tree.nodes) {
    for (const child of node.childIds ?? []) parent.set(child, node);
  }
  const roleOf = (node: AccessibilityNode) => String(node.role?.value ?? "");

  const runs = tree.nodes.flatMap((node) => {
    const text = typeof node.name?.value === "string" ? node.name.value.trim() : "";
    if (node.ignored || roleOf(node) !== "StaticText" || !text) return [];
    const elements = dom.ancestorElements(node.backendDOMNodeId ?? -1);
    const fontSize = Number.parseFloat(elements[0]?.style["font-size"] ?? "");
    const fontWeight = Number.parseFloat(elements[0]?.style["font-weight"] ?? "");
    const line = elements.find(({ style }) => isOwnLine(style.display));
    if (!line || !(fontSize > 0) || !(fontWeight > 0)) return [];
    let inTextRole = false;
    let control: string | undefined;
    for (let above = parent.get(node.nodeId); above; above = parent.get(above.nodeId)) {
      inTextRole ||= TEXT_ROLES.has(roleOf(above));
      if (!control && CONTROL_ROLES.has(roleOf(above))) control = above.nodeId;
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
  const controlLines = new Map<string, Set<string>>();
  for (const { control, line } of runs) {
    if (control)
      controlLines.set(control, (controlLines.get(control) ?? new Set()).add(line.nodePath));
  }
  const isControlName = (run: (typeof runs)[number]) =>
    run.control !== undefined && controlLines.get(run.control)!.size === 1;

  const lines = new Map<string, { line: CapturedElement; runs: typeof runs }>();
  for (const run of runs) {
    const entry = lines.get(run.line.nodePath) ?? { line: run.line, runs: [] };
    entry.runs.push(run);
    lines.set(run.line.nodePath, entry);
  }
  return [...lines.values()].flatMap(({ line, runs: lineRuns }) => {
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
