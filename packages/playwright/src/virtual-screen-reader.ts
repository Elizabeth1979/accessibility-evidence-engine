import { readFileSync } from "node:fs";
import path from "node:path";

import type { LiveRegionAnnouncement } from "@aee/core";

import {
  capturePageDom,
  withCdpSession,
  type AccessibilityNode,
  type AccessibilityValue,
  type CapturedElement,
  type CdpContext,
  type CdpSession
} from "./accessibility-tree";

export type VirtualScreenReaderCommand =
  | "start"
  | "next-item"
  | "previous-item"
  | "next-heading"
  | "previous-heading"
  | "next-landmark"
  | "next-control"
  | "read-current";

export interface VirtualScreenReaderItem {
  key: string;
  nodePath: string;
  tagName: string;
  /** The role in the browser's accessibility tree, or "text" for a piece of text. */
  role: string;
  /** The accessible name the browser computed. */
  name?: string;
  /** The words of a piece of text the reader stopped on. */
  text?: string;
  level?: number;
  states: string[];
  /** Page coordinates; absent when the element has no rendered box. */
  visualBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface VirtualScreenReaderEntry {
  sequence: number;
  timestamp: string;
  command: VirtualScreenReaderCommand;
  /** What the reader said, as Guidepup's virtual screen reader says it. */
  announcement: string;
  item?: VirtualScreenReaderItem;
  domFocusBefore?: string;
  domFocusAfter?: string;
  focusMoved: boolean;
}

export interface VirtualScreenReaderTranscript {
  schemaVersion: "0.1.0";
  engine: "aee-portable-virtual-screen-reader";
  engineVersion: "0.2.0";
  /** What decides what is spoken: Guidepup's virtual screen reader, and its version. */
  speechEngine: string;
  mode: "guide";
  fidelity: "semantic-simulation";
  physicalAssistiveTechnology: false;
  pageUrl: string;
  generatedAt: string;
  currentItem?: VirtualScreenReaderItem;
  entries: VirtualScreenReaderEntry[];
  /** Live-region updates the reader announced while it listened, oldest first. */
  liveRegionAnnouncements: LiveRegionAnnouncement[];
}

export function renderPortableVirtualScreenReaderTranscript(
  transcript: VirtualScreenReaderTranscript
): string {
  const lines = [
    "AEE portable virtual screen-reader transcript",
    "Fidelity: semantic simulation; not VoiceOver, NVDA, or another physical assistive technology.",
    `Speech: ${transcript.speechEngine}`,
    `Page: ${transcript.pageUrl}`,
    `Mode: ${transcript.mode}`,
    ""
  ];

  if (transcript.entries.length === 0) {
    lines.push("No commands recorded.");
  } else {
    for (const entry of transcript.entries) {
      lines.push(`${entry.sequence}. ${entry.command}: ${entry.announcement}`);
      lines.push(
        `   DOM focus: ${entry.domFocusBefore ?? "none"} -> ${entry.domFocusAfter ?? "none"}; moved: ${entry.focusMoved ? "yes" : "no"}`
      );
    }
  }

  if (transcript.liveRegionAnnouncements.length > 0) {
    lines.push("", "Live-region announcements:");
    for (const announcement of transcript.liveRegionAnnouncements) {
      lines.push(`${announcement.sequence}. ${announcement.politeness}: ${announcement.text}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export interface PortableVirtualScreenReader {
  command(command: VirtualScreenReaderCommand): Promise<VirtualScreenReaderEntry>;
  /** The item a command would move to, without moving; undefined at the end of the page. */
  peek(command: VirtualScreenReaderCommand): Promise<VirtualScreenReaderItem | undefined>;
  /**
   * Starts hearing the page's live regions, as a running screen reader does, without moving the
   * reading cursor. Does nothing when it already listens to this page.
   */
  listen(): Promise<void>;
  snapshot(): Promise<VirtualScreenReaderTranscript>;
}

export interface VirtualScreenReaderPage {
  url(): string;
  context(): CdpContext;
}

const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search"
]);

const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox"
]);

/** Roles that need an accessible name (ARIA: "accessible name required"). */
const NAME_REQUIRED_ROLES = new Set([
  ...CONTROL_ROLES,
  "alertdialog",
  "dialog",
  "heading",
  "image"
]);

/** Whether the reader announced an item whose role needs a name without one. */
export function announcedWithoutName(
  item: Pick<VirtualScreenReaderItem, "role" | "name">
): boolean {
  return NAME_REQUIRED_ROLES.has(item.role) && !item.name;
}

/** Chromium's own role names that platforms expose as an ARIA role; HTML-AAM maps summary to a button. */
const INTERNAL_ROLES = new Map([["DisclosureTriangle", "button"]]);

/** The role of a piece of text the reader stops on. */
const TEXT_ROLE = "text";

/** What Guidepup's reader says at each end of what it reads. */
const END_OF_DOCUMENT = "end of document";
const START_OF_DOCUMENT = "document";

/** More single steps than any page holds; a jump that finds nothing stops here. */
const MAX_STEPS = 10_000;

const BUNDLE_FILE = path.join(__dirname, "guidepup-virtual-screen-reader.js");
const BUNDLE_GLOBAL = "__aeeGuidepupVirtualScreenReader";
const SPEECH_ENGINE = `@guidepup/virtual-screen-reader ${
  (
    JSON.parse(
      readFileSync(require.resolve("@guidepup/virtual-screen-reader/package.json"), "utf8")
    ) as { version: string }
  ).version
}`;
let bundleSource: string | undefined;

type Primitive = "start" | "next" | "previous";

/** Where the reader is after a step: what it said and the DOM node it is on. */
interface Position {
  phrase: string;
  /** The node Guidepup's reader is on; absent at either end of the page. */
  backendNodeId?: number;
  isText: boolean;
  text?: string;
}

/**
 * Reads the page item by item with Guidepup's virtual screen reader
 * ([`@guidepup/virtual-screen-reader`](https://github.com/guidepup/virtual-screen-reader)), which
 * follows the W3C mappings (ARIA, accname, Core-AAM, HTML-AAM) and is tested against the Web
 * Platform Tests. Guidepup decides what is said; AEE adds where on the page each step is, and the
 * role and name the browser gives that element, so every announcement is evidence that can be
 * located and cross-checked.
 *
 * Guidepup's reader runs in the page. It is loaded as a plain script over the DevTools protocol,
 * the way Deque's official @axe-core/playwright loads axe (`page.evaluate` of its source), so a
 * page's Content-Security-Policy does not refuse it and no security setting is switched off. It reads the page but never focuses, clicks,
 * types, or dispatches events. It is useful portable evidence, not a substitute for VoiceOver,
 * NVDA or JAWS.
 */
export function createPortableVirtualScreenReader(
  page: VirtualScreenReaderPage
): PortableVirtualScreenReader {
  const entries: VirtualScreenReaderEntry[] = [];
  const liveRegionAnnouncements: LiveRegionAnnouncement[] = [];
  let currentItem: VirtualScreenReaderItem | undefined;
  // Every forward step since the reader last started or moved back. Guidepup keeps the reader
  // inside an open modal dialog, as screen readers do, and comes round to its start again: a
  // forward step onto a node and phrase already passed is the end of what there is to read.
  let readInThisPass = new Set<string>();

  const session = <Result>(use: (session: CdpSession) => Promise<Result>) =>
    withCdpSession(page.context(), page, use);

  return {
    async command(command) {
      return session(async (cdp) => {
        const focusBefore = await activeElementNode(cdp);
        if (command === "start" || !forward(command)) readInThisPass = new Set();
        const position = await move(cdp, command, { record: readInThisPass });
        const dom = await capturePageDom(cdp);
        const item = position && (await itemAt(cdp, dom, position));
        if (item) currentItem = item;
        const focusAfter = await activeElementNode(cdp);
        const focusPath = (id: number | undefined) =>
          id === undefined ? undefined : dom.element(id)?.nodePath;
        const domFocusBefore = focusPath(focusBefore);
        const domFocusAfter = focusPath(focusAfter);
        const entry: VirtualScreenReaderEntry = {
          sequence: entries.length + 1,
          timestamp: new Date().toISOString(),
          command,
          announcement: position?.phrase || (await lastSpokenPhrase(cdp)),
          ...(item ? { item } : {}),
          ...(domFocusBefore ? { domFocusBefore } : {}),
          ...(domFocusAfter ? { domFocusAfter } : {}),
          focusMoved: focusBefore !== focusAfter
        };
        entries.push(entry);
        return cloneEntry(entry);
      });
    },
    async peek(command) {
      return session(async (cdp) => {
        const moved = await move(cdp, command, {
          record: new Set(readInThisPass),
          countSteps: true
        });
        const item =
          moved?.position && (await itemAt(cdp, await capturePageDom(cdp), moved.position));
        // Step back exactly as far as the command went, so peeking leaves the reader where it was.
        const back: Primitive = forward(command) ? "previous" : "next";
        for (let step = 0; step < (moved?.steps ?? 0); step++) await guidepup(cdp, back);
        return item && cloneItem(item);
      });
    },
    async listen() {
      await session(async (cdp) => {
        await loadGuidepup(cdp);
        await evaluate(
          cdp,
          `(async () => {
            if (window.__aeeGuidepupListener) return;
            // A reader of its own, so listening never moves the cursor the commands read with.
            window.__aeeGuidepupListener = new ${BUNDLE_GLOBAL}.Virtual();
            window.__aeeGuidepupListenerRead = 0;
            await window.__aeeGuidepupListener.start({ container: document.body });
          })()`
        );
      });
    },
    async snapshot() {
      const heard = await session((cdp) => heardSinceLastRead(cdp));
      for (const phrase of heard) {
        const announcement = liveRegionAnnouncement(phrase, liveRegionAnnouncements.length + 1);
        if (announcement) liveRegionAnnouncements.push(announcement);
      }
      return {
        schemaVersion: "0.1.0",
        engine: "aee-portable-virtual-screen-reader",
        engineVersion: "0.2.0",
        speechEngine: SPEECH_ENGINE,
        mode: "guide",
        fidelity: "semantic-simulation",
        physicalAssistiveTechnology: false,
        pageUrl: page.url(),
        generatedAt: new Date().toISOString(),
        ...(currentItem ? { currentItem: cloneItem(currentItem) } : {}),
        entries: entries.map(cloneEntry),
        liveRegionAnnouncements: liveRegionAnnouncements.map((announcement) => ({
          ...announcement
        }))
      };
    }
  };
}

function forward(command: VirtualScreenReaderCommand): boolean {
  return command !== "previous-item" && command !== "previous-heading";
}

/** Whether a command stops at a node with this role: an item, a heading, a landmark or a control. */
function stopsAt(command: VirtualScreenReaderCommand, role: string): boolean {
  if (command === "next-heading" || command === "previous-heading") return role === "heading";
  if (command === "next-landmark") return LANDMARK_ROLES.has(role);
  if (command === "next-control") return CONTROL_ROLES.has(role);
  return true;
}

function atEnd(position: Position): boolean {
  return (
    position.backendNodeId === undefined ||
    position.phrase === END_OF_DOCUMENT ||
    position.phrase === START_OF_DOCUMENT
  );
}

/**
 * Moves Guidepup's reader for one command, a single step at a time, so every command can be
 * undone exactly. Returns where it stopped, or undefined at either end of the page (the reader
 * stays there, as a screen reader does).
 */
async function move(
  cdp: CdpSession,
  command: VirtualScreenReaderCommand,
  options: { record: Set<string> | undefined; countSteps?: false }
): Promise<Position | undefined>;
async function move(
  cdp: CdpSession,
  command: VirtualScreenReaderCommand,
  options: { record: Set<string> | undefined; countSteps: true }
): Promise<{ position: Position | undefined; steps: number } | undefined>;
async function move(
  cdp: CdpSession,
  command: VirtualScreenReaderCommand,
  { record, countSteps }: { record: Set<string> | undefined; countSteps?: boolean }
): Promise<Position | { position: Position | undefined; steps: number } | undefined> {
  const result = (position: Position | undefined, steps: number) =>
    countSteps ? { position, steps } : position;

  if (command === "start") {
    const position = await guidepup(cdp, "start");
    if (atEnd(position)) return result(undefined, 0);
    record?.add(positionKey(position));
    return result(position, 0);
  }
  if (command === "read-current") {
    const position = await guidepup(cdp, "current");
    return result(atEnd(position) ? undefined : position, 0);
  }

  const primitive: Primitive = forward(command) ? "next" : "previous";
  const passed = record ?? new Set<string>();
  for (let steps = 1; steps <= MAX_STEPS; steps++) {
    const position = await guidepup(cdp, primitive);
    if (atEnd(position)) return result(undefined, steps);
    if (primitive === "next") {
      const key = positionKey(position);
      if (passed.has(key)) return result(undefined, steps);
      passed.add(key);
    }
    // A jump stops where an element begins, not where Guidepup says it ends ("end of list").
    if (position.phrase.startsWith("end of ")) {
      if (command === "next-item" || command === "previous-item") return result(position, steps);
      continue;
    }
    if (stopsAt(command, await roleAt(cdp, position))) return result(position, steps);
  }
  return result(undefined, MAX_STEPS);
}

function positionKey({ backendNodeId, phrase }: Position): string {
  return `${backendNodeId}\u0000${phrase}`;
}

/**
 * Runs one of Guidepup's reader commands in the page, loading and starting the reader first when
 * the page does not have it (a fresh page, or one that has navigated), and reports where it is.
 */
async function guidepup(cdp: CdpSession, action: Primitive | "current"): Promise<Position> {
  await loadGuidepup(cdp);
  const position = await evaluate<{
    phrase: string;
    isText: boolean;
    text?: string;
    hasNode: boolean;
  }>(
    cdp,
    `(async () => {
      const reader = ${BUNDLE_GLOBAL}.virtual;
      const action = ${JSON.stringify(action)};
      if (action === "start" || !window.__aeeGuidepupStarted) {
        if (window.__aeeGuidepupStarted) await reader.stop();
        await reader.start({ container: document.body });
        window.__aeeGuidepupStarted = true;
        // Guidepup's reader starts on the document itself; the first step is the page's first
        // item, which is also where any first command lands on a page not read before.
        await reader.next();
      } else if (action === "next") {
        await reader.next();
      } else if (action === "previous") {
        await reader.previous();
      }
      const node = reader.activeNode;
      window.__aeeGuidepupNode = node;
      return {
        phrase: await reader.lastSpokenPhrase(),
        isText: node?.nodeType === Node.TEXT_NODE,
        text: node?.nodeType === Node.TEXT_NODE ? node.textContent : undefined,
        hasNode: Boolean(node) && node !== document.body
      };
    })()`
  );
  const backendNodeId = position.hasNode
    ? await backendNodeOf(cdp, "window.__aeeGuidepupNode")
    : undefined;
  const text = position.text?.replace(/\s+/g, " ").trim();
  return {
    phrase: position.phrase,
    isText: position.isText,
    ...(text ? { text } : {}),
    ...(backendNodeId === undefined ? {} : { backendNodeId })
  };
}

/** Loads Guidepup's reader into the page when the page does not have it (fresh, or navigated). */
async function loadGuidepup(cdp: CdpSession): Promise<void> {
  const loaded = await evaluate<boolean>(cdp, `typeof ${BUNDLE_GLOBAL} === "object"`);
  if (!loaded) {
    bundleSource ??= readFileSync(BUNDLE_FILE, "utf8");
    await evaluate(cdp, bundleSource);
  }
}

/**
 * What the listening reader said since this was last asked, from Guidepup's spoken-phrase log.
 * Nothing when it does not listen to this page, as after the page navigated.
 */
async function heardSinceLastRead(cdp: CdpSession): Promise<string[]> {
  return evaluate<string[]>(
    cdp,
    `(async () => {
      const listener = window.__aeeGuidepupListener;
      if (!listener) return [];
      const log = await listener.spokenPhraseLog();
      const heard = log.slice(window.__aeeGuidepupListenerRead);
      window.__aeeGuidepupListenerRead = log.length;
      return heard;
    })()`
  );
}

/**
 * A live-region update as Guidepup says it: the politeness, a colon, then the words
 * ("polite: Saved"). Its log also holds what it says as focus moves; those are not announcements.
 */
function liveRegionAnnouncement(
  phrase: string,
  sequence: number
): LiveRegionAnnouncement | undefined {
  const match = /^(polite|assertive): ([\s\S]*)$/.exec(phrase);
  if (!match) return undefined;
  return {
    sequence,
    timestamp: new Date().toISOString(),
    politeness: match[1] as LiveRegionAnnouncement["politeness"],
    text: match[2]!
  };
}

async function lastSpokenPhrase(cdp: CdpSession): Promise<string> {
  return evaluate<string>(
    cdp,
    `typeof ${BUNDLE_GLOBAL} === "object" ? ${BUNDLE_GLOBAL}.virtual.lastSpokenPhrase() : ""`
  );
}

/** The item for where the reader is: the browser's role, name and states, and where it is drawn. */
async function itemAt(
  cdp: CdpSession,
  dom: Awaited<ReturnType<typeof capturePageDom>>,
  position: Position
): Promise<VirtualScreenReaderItem | undefined> {
  if (position.backendNodeId === undefined) return undefined;
  const element = dom.closestElement(position.backendNodeId);
  if (!element) return undefined;
  const at = {
    nodePath: element.nodePath,
    tagName: element.tagName,
    ...(element.visualBounds ? { visualBounds: element.visualBounds } : {})
  };
  if (position.isText) {
    return {
      key: `${element.nodePath}#text:${position.text ?? ""}`,
      ...at,
      role: TEXT_ROLE,
      ...(position.text ? { text: position.text } : {}),
      states: currentState(element)
    };
  }
  const node = await accessibilityNode(cdp, position.backendNodeId);
  const role = roleOf(node);
  const name = textValue(node?.name);
  const level = role === "heading" && node ? propertyValue(node, "level") : undefined;
  return {
    // The same element is read as it begins and as it ends ("end of list"), so the phrase is part
    // of where the reader is.
    key: `${element.nodePath}#${position.phrase.startsWith("end of ") ? "end" : "start"}`,
    ...at,
    role,
    ...(name ? { name } : {}),
    ...(typeof level === "number" ? { level } : {}),
    states: node ? itemStates(node, element) : currentState(element)
  };
}

async function roleAt(cdp: CdpSession, position: Position): Promise<string> {
  if (position.isText || position.backendNodeId === undefined) return TEXT_ROLE;
  return roleOf(await accessibilityNode(cdp, position.backendNodeId));
}

function roleOf(node: AccessibilityNode | undefined): string {
  const role = textValue(node?.role) ?? "generic";
  return INTERNAL_ROLES.get(role) ?? role;
}

/** The browser's accessibility node for a DOM node. */
async function accessibilityNode(
  cdp: CdpSession,
  backendNodeId: number
): Promise<AccessibilityNode | undefined> {
  const { nodes } = (await cdp.send("Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: false
  })) as { nodes: AccessibilityNode[] };
  return nodes.find((node) => node.backendDOMNodeId === backendNodeId) ?? nodes[0];
}

function itemStates(node: AccessibilityNode, element: CapturedElement): string[] {
  const states: string[] = [];
  const expanded = propertyValue(node, "expanded");
  if (expanded === true) states.push("expanded");
  if (expanded === false) states.push("collapsed");
  const checked = propertyValue(node, "checked");
  if (checked === "true") states.push("checked");
  if (checked === "mixed") states.push("partially checked");
  if (propertyValue(node, "selected") === true) states.push("selected");
  const pressed = propertyValue(node, "pressed");
  if (pressed === "true") states.push("pressed");
  if (pressed === "mixed") states.push("partially pressed");
  if (propertyValue(node, "disabled") === true) states.push("disabled");
  if (propertyValue(node, "required") === true) states.push("required");
  states.push(...currentState(element));
  return states;
}

/** The tree has no aria-current property, so it is read from the element. */
function currentState(element: CapturedElement): string[] {
  const current = element.attribute("aria-current");
  if (!current || current === "false") return [];
  return [current === "true" ? "current" : `current ${current}`];
}

function propertyValue(node: AccessibilityNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value.value;
}

function textValue(value: AccessibilityValue | undefined): string | undefined {
  const text = typeof value?.value === "string" ? value.value.trim() : "";
  return text || undefined;
}

function cloneItem(item: VirtualScreenReaderItem): VirtualScreenReaderItem {
  return {
    ...item,
    states: [...item.states],
    ...(item.visualBounds ? { visualBounds: { ...item.visualBounds } } : {})
  };
}

function cloneEntry(entry: VirtualScreenReaderEntry): VirtualScreenReaderEntry {
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    command: entry.command,
    announcement: entry.announcement,
    ...(entry.item ? { item: cloneItem(entry.item) } : {}),
    ...(entry.domFocusBefore ? { domFocusBefore: entry.domFocusBefore } : {}),
    ...(entry.domFocusAfter ? { domFocusAfter: entry.domFocusAfter } : {}),
    focusMoved: entry.focusMoved
  };
}

/**
 * Evaluates script in the page over the DevTools protocol. It runs as the protocol's own code, so
 * the page's Content-Security-Policy does not apply to it.
 */
async function evaluate<Value>(cdp: CdpSession, expression: string): Promise<Value> {
  const { result, exceptionDetails } = (await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  })) as {
    result: { value?: Value };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };
  if (exceptionDetails) {
    throw new Error(
      `Virtual screen reader failed in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`
    );
  }
  return result.value as Value;
}

/** The DOM node an expression evaluates to, as the backend id the DOM snapshot uses. */
async function backendNodeOf(cdp: CdpSession, expression: string): Promise<number | undefined> {
  const { result } = (await cdp.send("Runtime.evaluate", { expression })) as {
    result: { objectId?: string };
  };
  if (!result.objectId) return undefined;
  const { node } = (await cdp.send("DOM.describeNode", { objectId: result.objectId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}

/** The DOM node that has focus, found the way the page sees it: document.activeElement. */
async function activeElementNode(cdp: CdpSession): Promise<number | undefined> {
  return backendNodeOf(cdp, "document.activeElement");
}
