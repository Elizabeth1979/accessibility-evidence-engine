import { readFileSync } from "node:fs";
import path from "node:path";

import {
  focusPlace,
  frameNotes,
  READER_NOTES_LEGEND,
  spokenRoleOf,
  TEXT_ROLE,
  type LiveRegionAnnouncement
} from "@aee/core";

import {
  capturePageDom,
  fetchAccessibilityNode,
  mainFrameOf,
  withPageSessions,
  type AccessibilityNode,
  type AccessibilityProperty,
  type AccessibilityValue,
  type CapturedDom,
  type CapturedElement,
  type CdpContext,
  type CdpSession,
  type DomNodeRef,
  type FramedPage,
  type PageFrame,
  type PageSessions
} from "./accessibility-tree";
import { focusPath, frameHeldAt } from "./dom-focus";
import { callOn, documentOf, nodeOf } from "./frame-documents";

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
  /** The accessible description the browser computed, such as from `aria-describedby`. */
  description?: string;
  /** The value the browser exposes, such as a text field's text or a slider's position. */
  value?: string | number;
  /** The words of a piece of text the reader stopped on. */
  text?: string;
  level?: number;
  /** The states a screen reader says aloud, in words. */
  states: string[];
  /**
   * Every state and property the browser's accessibility tree gives the element, exactly as
   * Chrome reports them (CDP `AXProperty`): `focusable`, `invalid`, `hasPopup`, `describedby`…
   */
  properties?: AccessibilityProperty[];
  /**
   * The DOM node the reader is on, as this browser session numbers it. It joins the item to the
   * accessibility tree and DOM snapshot taken in the same session, node for node.
   */
  backendDOMNodeId?: number;
  /**
   * The frame whose document holds the node. With `backendDOMNodeId` it names the node across
   * every frame, since node ids repeat in frames rendered in other processes.
   */
  frameId?: string;
  /**
   * The `<iframe>` elements the node is inside, outermost first, each as a path in the document
   * that holds it, as the element map and axe-core's `target` list them. Absent in the top
   * document.
   */
  framePath?: string[];
  /** Page coordinates; absent when the element has no rendered box. */
  visualBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * The element that has DOM focus, named as an item names the element it is on. When focus is
 * inside a frame it is the focused element in that frame's own document, not the `<iframe>`.
 */
export interface VirtualScreenReaderFocus {
  /** Its path in the document that holds it. */
  nodePath: string;
  /** The DOM node, as this browser session numbers it in its frame's process. */
  backendDOMNodeId: number;
  /** The frame whose document holds it. */
  frameId: string;
  /** The `<iframe>` elements it is inside, outermost first. Absent in the top document. */
  framePath?: string[];
}

/** A frame the reader went into or came out of. */
export interface VirtualScreenReaderFrame {
  /** The frame's id: the `frameId` of every item read inside it. */
  frameId: string;
  /**
   * The `<iframe>` elements that hold the frame's document, outermost first and ending with its
   * own: the `framePath` of every item read inside it.
   */
  framePath: string[];
  /** The frame element's accessible name, as the browser computes it (usually its `title`). */
  name?: string;
}

export interface VirtualScreenReaderEntry {
  sequence: number;
  timestamp: string;
  command: VirtualScreenReaderCommand;
  /** What the reader said, as Guidepup's virtual screen reader says it. */
  announcement: string;
  /**
   * The frames this command came out of, innermost first. Guidepup says nothing as it leaves a
   * frame, where NVDA says "out of frame"; the transcript notes it in AEE's own words.
   */
  framesLeft?: VirtualScreenReaderFrame[];
  /** The frames this command went into, outermost first. */
  framesEntered?: VirtualScreenReaderFrame[];
  item?: VirtualScreenReaderItem;
  /** The element that had DOM focus before the command, in whichever frame holds it. */
  domFocusBefore?: VirtualScreenReaderFocus;
  /** The element that had DOM focus after the command, in whichever frame holds it. */
  domFocusAfter?: VirtualScreenReaderFocus;
  /** Whether DOM focus is on another element after the command, in any frame. */
  focusMoved: boolean;
}

export interface VirtualScreenReaderTranscript {
  schemaVersion: "0.1.0";
  engine: "aee-portable-virtual-screen-reader";
  engineVersion: "0.3.0";
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
    READER_NOTES_LEGEND,
    ""
  ];

  if (transcript.entries.length === 0) {
    lines.push("No commands recorded.");
  } else {
    for (const entry of transcript.entries) {
      lines.push(...frameNotes(entry));
      lines.push(`${entry.sequence}. ${entry.command}: ${entry.announcement}`);
      lines.push(
        `   DOM focus: ${focusPlace(entry.domFocusBefore)} -> ${focusPlace(entry.domFocusAfter)}; moved: ${entry.focusMoved ? "yes" : "no"}`
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

export interface VirtualScreenReaderPage extends FramedPage {
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

/** A step of Guidepup's reader in one frame's document. */
type Action = "start" | "end" | "next" | "previous" | "current";
type Primitive = "next" | "previous";

/** Where the reader is after a step: what it said and the DOM node it is on. */
interface Position {
  /** The frame whose document the reader is in. */
  frameId: string;
  phrase: string;
  /** The node Guidepup's reader is on; absent at either end of a document. */
  backendNodeId?: number;
  isText: boolean;
  text?: string;
}

/**
 * Where the reader is between commands: the frames it is inside below the top document, outermost
 * first, and where it is in the innermost one.
 */
interface Cursor {
  frames: string[];
  on?: Position;
}

/** The page as one command reads it: its frames, each frame's document, and the cursor. */
interface Reading {
  page: PageSessions;
  cursor: Cursor;
  document(frame: PageFrame): Promise<string | undefined>;
}

/**
 * Reads the page item by item with Guidepup's virtual screen reader
 * ([`@guidepup/virtual-screen-reader`](https://github.com/guidepup/virtual-screen-reader)), which
 * follows the W3C mappings (ARIA, accname, Core-AAM, HTML-AAM) and is tested against the Web
 * Platform Tests. Guidepup decides what is said; AEE adds where on the page each step is, and the
 * role and name the browser gives that element, so every announcement is evidence that can be
 * located and cross-checked.
 *
 * Guidepup's reader builds its tree from each node's children, so it never enters a frame's
 * document. AEE runs one Guidepup reader in each frame's own document, the way Deque's official
 * @axe-core/playwright runs axe in every frame, and steps between them as NVDA and JAWS read a
 * frame in place: after a frame's element the next step is the frame's first item, after its last
 * item the reader comes out and reads on after the frame, and a step back undoes each step
 * exactly. A frame Chrome renders in a process of its own, as it does a cross-site one, is read
 * through that process's session, so frames the page's own scripts cannot see into are read too.
 *
 * Guidepup's reader is loaded into each document as a plain script over the DevTools protocol, the
 * way @axe-core/playwright loads axe, so a page's Content-Security-Policy does not refuse it and no
 * security setting is switched off. It reads the page but never focuses, clicks, types, or
 * dispatches events. It is useful portable evidence, not a substitute for VoiceOver, NVDA or JAWS.
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
  const cursor: Cursor = { frames: [] };

  const read = <Result>(use: (reading: Reading) => Promise<Result>) =>
    withPageSessions(page.context(), page, (frames) => use(readingOf(frames, cursor)));

  return {
    async command(command) {
      return read(async (reading) => {
        const top = mainFrameOf(reading.page);
        const focusBefore = await focusedNode(reading);
        if (command === "start" || !forward(command)) readInThisPass = new Set();
        const framesBefore = [...cursor.frames];
        const position = await move(reading, command, { record: readInThisPass });
        // Focus is read before the DOM snapshot, so the snapshot holds the element it is on.
        const focusAfter = await focusedNode(reading);
        const dom = await capturePageDom(reading.page);
        const item = position && (await itemAt(reading.page, dom, position));
        if (item) currentItem = item;
        const crossed = await framesCrossed(reading.page, dom, framesBefore, cursor.frames);
        const domFocusBefore = focusAt(dom, focusBefore);
        const domFocusAfter = focusAt(dom, focusAfter);
        const entry: VirtualScreenReaderEntry = {
          sequence: entries.length + 1,
          timestamp: new Date().toISOString(),
          command,
          announcement: position?.phrase || (await lastSpokenPhrase(reading, top)),
          ...crossed,
          ...(item ? { item } : {}),
          ...(domFocusBefore ? { domFocusBefore } : {}),
          ...(domFocusAfter ? { domFocusAfter } : {}),
          focusMoved: nodeKey(focusBefore) !== nodeKey(focusAfter)
        };
        entries.push(entry);
        return cloneEntry(entry);
      });
    },
    async peek(command) {
      return read(async (reading) => {
        const moved = await move(reading, command, {
          record: new Set(readInThisPass),
          countSteps: true
        });
        const item =
          moved?.position &&
          (await itemAt(reading.page, await capturePageDom(reading.page), moved.position));
        // Step back exactly as far as the command went, so peeking leaves the reader where it was.
        const back: Primitive = forward(command) ? "previous" : "next";
        for (let steps = 0; steps < (moved?.steps ?? 0); steps++) await step(reading, back);
        return item && cloneItem(item);
      });
    },
    async listen() {
      await read(async (reading) => {
        const top = mainFrameOf(reading.page);
        const document = await reading.document(top);
        if (!document) return;
        await loadGuidepup(top.session, document);
        await callOn(
          top.session,
          document,
          `async function () {
            if (globalThis.__aeeGuidepupListener) return;
            // A reader of its own, so listening never moves the cursor the commands read with.
            globalThis.__aeeGuidepupListener = new globalThis.${BUNDLE_GLOBAL}.Virtual();
            globalThis.__aeeGuidepupListenerRead = 0;
            await globalThis.__aeeGuidepupListener.start({ container: document.body });
          }`
        );
      });
    },
    async snapshot() {
      const heard = await read((reading) => heardSinceLastRead(reading));
      for (const phrase of heard) {
        const announcement = liveRegionAnnouncement(phrase, liveRegionAnnouncements.length + 1);
        if (announcement) liveRegionAnnouncements.push(announcement);
      }
      return {
        schemaVersion: "0.1.0",
        engine: "aee-portable-virtual-screen-reader",
        engineVersion: "0.3.0",
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

/**
 * The page for one command. A frame the reader was inside that has gone since is left: the reader
 * reads on from the frame that held it.
 */
function readingOf(page: PageSessions, cursor: Cursor): Reading {
  let parent = mainFrameOf(page).frameId;
  const gone = cursor.frames.findIndex((frameId) => {
    const held = page.frames.some(
      (frame) => frame.frameId === frameId && frame.parentFrameId === parent
    );
    parent = frameId;
    return !held;
  });
  if (gone !== -1) {
    cursor.frames.splice(gone);
    delete cursor.on;
  }
  const documents = new Map<string, Promise<string | undefined>>();
  return {
    page,
    cursor,
    document(frame) {
      let document = documents.get(frame.frameId);
      if (!document) {
        document = documentOf(page, frame);
        documents.set(frame.frameId, document);
      }
      return document;
    }
  };
}

function frameById(page: PageSessions, frameId: string): PageFrame {
  return page.frames.find((frame) => frame.frameId === frameId)!;
}

/** The frame whose document the reader is in. */
function innerFrame({ page, cursor }: Reading): PageFrame {
  return frameById(page, cursor.frames.at(-1) ?? mainFrameOf(page).frameId);
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
 * Moves the reader for one command, a single step at a time, so every command can be undone
 * exactly. Returns where it stopped, or undefined at either end of the page (the reader stays
 * there, as a screen reader does).
 */
async function move(
  reading: Reading,
  command: VirtualScreenReaderCommand,
  options: { record: Set<string> | undefined; countSteps?: false }
): Promise<Position | undefined>;
async function move(
  reading: Reading,
  command: VirtualScreenReaderCommand,
  options: { record: Set<string> | undefined; countSteps: true }
): Promise<{ position: Position | undefined; steps: number } | undefined>;
async function move(
  reading: Reading,
  command: VirtualScreenReaderCommand,
  { record, countSteps }: { record: Set<string> | undefined; countSteps?: boolean }
): Promise<Position | { position: Position | undefined; steps: number } | undefined> {
  const { cursor } = reading;
  const result = (position: Position | undefined, steps: number) =>
    countSteps ? { position, steps } : position;

  if (command === "start") {
    cursor.frames = [];
    const position = await guidepup(reading, mainFrameOf(reading.page), "start");
    cursor.on = position;
    if (atEnd(position)) return result(undefined, 0);
    record?.add(positionKey(position));
    return result(position, 0);
  }
  if (command === "read-current") {
    const position = await guidepup(reading, innerFrame(reading), "current");
    cursor.on = position;
    return result(atEnd(position) ? undefined : position, 0);
  }

  const primitive: Primitive = forward(command) ? "next" : "previous";
  const passed = record ?? new Set<string>();
  for (let steps = 1; steps <= MAX_STEPS; steps++) {
    const position = await step(reading, primitive);
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
    if (stopsAt(command, await roleAt(reading.page, position))) return result(position, steps);
  }
  return result(undefined, MAX_STEPS);
}

/**
 * One step through the page, frames included, in one reading order. A frame's element is read
 * before the frame: the step after it is the frame's first item, and the step after the frame's
 * last item is whatever follows the frame. A step back retraces each of these, so it goes into a
 * frame from below at its last item and comes out at its element. An empty frame is stepped over.
 */
async function step(reading: Reading, primitive: Primitive): Promise<Position> {
  const { page, cursor } = reading;
  let position: Position;
  if (primitive === "next") {
    const held = frameHeldAt(page, cursor.on);
    if (held) {
      cursor.frames.push(held.frameId);
      position = await guidepup(reading, held, "start");
    } else {
      position = await guidepup(reading, innerFrame(reading), "next");
    }
    // At the end of a frame's document the reader comes out, still on the frame's element.
    while (atEnd(position) && cursor.frames.length) {
      cursor.frames.pop();
      position = await guidepup(reading, innerFrame(reading), "next");
    }
  } else {
    position = await guidepup(reading, innerFrame(reading), "previous");
    if (atEnd(position) && cursor.frames.length) {
      cursor.frames.pop();
      position = await guidepup(reading, innerFrame(reading), "current");
    } else {
      for (let held = frameHeldAt(page, position); held; held = frameHeldAt(page, position)) {
        cursor.frames.push(held.frameId);
        await guidepup(reading, held, "end");
        const last = await guidepup(reading, held, "previous");
        if (atEnd(last)) {
          cursor.frames.pop();
          break;
        }
        position = last;
      }
    }
  }
  cursor.on = position;
  return position;
}

function positionKey({ frameId, backendNodeId, phrase }: Position): string {
  return `${frameId}\u0000${backendNodeId}\u0000${phrase}`;
}

/**
 * One step of Guidepup's reader in a frame's document, starting the reader first when the document
 * does not have it running (a fresh frame, or one that has loaded another page). It reports where
 * the reader is and keeps that node for `nodeOf`.
 */
const READ_STEP = `async function (action) {
  const reader = globalThis.${BUNDLE_GLOBAL}.virtual;
  if (!document.body) return { phrase: "", isText: false, hasNode: false };
  if (action === "start" || action === "end" || !globalThis.__aeeGuidepupStarted) {
    if (globalThis.__aeeGuidepupStarted) await reader.stop();
    await reader.start({ container: document.body });
    globalThis.__aeeGuidepupStarted = true;
    // Guidepup's reader starts on the document itself. A step forward is its first item, which is
    // also where any first command lands in a document not read before; a step back is its end.
    if (action === "end") await reader.previous();
    else await reader.next();
  } else if (action === "next") {
    await reader.next();
  } else if (action === "previous") {
    await reader.previous();
  }
  const node = reader.activeNode;
  globalThis.__aeeGuidepupNode = node;
  return {
    phrase: await reader.lastSpokenPhrase(),
    isText: node?.nodeType === Node.TEXT_NODE,
    text: node?.nodeType === Node.TEXT_NODE ? node.textContent : undefined,
    hasNode: Boolean(node) && node !== document.body
  };
}`;

/**
 * Runs one of Guidepup's reader steps in a frame's own document, loading the reader into it first
 * when it is not there, and reports where it is. A frame with no document to read reads as empty.
 */
async function guidepup(reading: Reading, frame: PageFrame, action: Action): Promise<Position> {
  const document = await reading.document(frame);
  if (!document) return { frameId: frame.frameId, phrase: "", isText: false };
  await loadGuidepup(frame.session, document);
  const position = await callOn<{
    phrase: string;
    isText: boolean;
    text?: string;
    hasNode: boolean;
  }>(frame.session, document, READ_STEP, [action]);
  const backendNodeId = position.hasNode
    ? await nodeOf(frame.session, document, "function () { return globalThis.__aeeGuidepupNode; }")
    : undefined;
  const text = position.text?.replace(/\s+/g, " ").trim();
  return {
    frameId: frame.frameId,
    phrase: position.phrase,
    isText: position.isText,
    ...(text ? { text } : {}),
    ...(backendNodeId === undefined ? {} : { backendNodeId })
  };
}

/** Loads Guidepup's reader into a frame's document when it does not have it (fresh, or navigated). */
async function loadGuidepup(cdp: CdpSession, document: string): Promise<void> {
  const loaded = await callOn<boolean>(
    cdp,
    document,
    `function () { return typeof globalThis.${BUNDLE_GLOBAL} === "object"; }`
  );
  if (loaded) return;
  bundleSource ??= readFileSync(BUNDLE_FILE, "utf8");
  // The bundle declares its global with \`var\`, which a function body keeps to itself.
  await callOn(
    cdp,
    document,
    `function () {\n${bundleSource}\nglobalThis.${BUNDLE_GLOBAL} = ${BUNDLE_GLOBAL};\n}`
  );
}

/**
 * What the listening reader said since this was last asked, from Guidepup's spoken-phrase log.
 * Nothing when it does not listen to the page, as after the page navigated.
 */
async function heardSinceLastRead(reading: Reading): Promise<string[]> {
  const top = mainFrameOf(reading.page);
  const document = await reading.document(top);
  if (!document) return [];
  return callOn<string[]>(
    top.session,
    document,
    `async function () {
      const listener = globalThis.__aeeGuidepupListener;
      if (!listener) return [];
      const log = await listener.spokenPhraseLog();
      const heard = log.slice(globalThis.__aeeGuidepupListenerRead);
      globalThis.__aeeGuidepupListenerRead = log.length;
      return heard;
    }`
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

async function lastSpokenPhrase(reading: Reading, frame: PageFrame): Promise<string> {
  const document = await reading.document(frame);
  return document
    ? callOn<string>(
        frame.session,
        document,
        `function () {
          return typeof globalThis.${BUNDLE_GLOBAL} === "object"
            ? globalThis.${BUNDLE_GLOBAL}.virtual.lastSpokenPhrase()
            : "";
        }`
      )
    : "";
}

/** The item for where the reader is: the browser's role, name and states, and where it is drawn. */
async function itemAt(
  page: PageSessions,
  dom: CapturedDom,
  position: Position
): Promise<VirtualScreenReaderItem | undefined> {
  const ref = domNodeAt(position);
  if (!ref) return undefined;
  const element = dom.closestElement(ref);
  if (!element) return undefined;
  // A path names an element in its own document; the frames it is inside make it unique.
  const place = [...element.framePath, element.nodePath].join(" >>> ");
  const at = {
    nodePath: element.nodePath,
    tagName: element.tagName,
    ...(element.visualBounds ? { visualBounds: element.visualBounds } : {}),
    backendDOMNodeId: ref.backendNodeId,
    frameId: ref.frameId,
    ...(element.framePath.length ? { framePath: [...element.framePath] } : {})
  };
  if (position.isText) {
    return {
      key: `${place}#text:${position.text ?? ""}`,
      ...at,
      role: TEXT_ROLE,
      ...(position.text ? { text: position.text } : {}),
      states: currentState(element)
    };
  }
  const node = await fetchAccessibilityNode(page, ref);
  const role = roleOf(node);
  const name = textValue(node?.name);
  const description = textValue(node?.description);
  const value = node?.value?.value;
  const level = role === "heading" && node ? propertyValue(node, "level") : undefined;
  return {
    // The same element is read as it begins and as it ends ("end of list"), so the phrase is part
    // of where the reader is.
    key: `${place}#${position.phrase.startsWith("end of ") ? "end" : "start"}`,
    ...at,
    role,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(typeof value === "string" || typeof value === "number" ? { value } : {}),
    ...(typeof level === "number" ? { level } : {}),
    states: node ? itemStates(node, element) : currentState(element),
    ...(node?.properties ? { properties: node.properties } : {})
  };
}

async function roleAt(page: PageSessions, position: Position): Promise<string> {
  const ref = domNodeAt(position);
  if (position.isText || !ref) return TEXT_ROLE;
  return roleOf(await fetchAccessibilityNode(page, ref));
}

/** The node the reader is on, in the document of the frame it is reading. */
function domNodeAt({ frameId, backendNodeId }: Position): DomNodeRef | undefined {
  return backendNodeId === undefined ? undefined : { frameId, backendNodeId };
}

/** The frames a command came out of, innermost first, and went into, outermost first. */
async function framesCrossed(
  page: PageSessions,
  dom: CapturedDom,
  before: string[],
  after: string[]
): Promise<Pick<VirtualScreenReaderEntry, "framesLeft" | "framesEntered">> {
  let shared = 0;
  while (shared < Math.min(before.length, after.length) && before[shared] === after[shared]) {
    shared++;
  }
  const describe = (frameIds: string[]) =>
    Promise.all(frameIds.map((frameId) => describeFrame(page, dom, frameId)));
  const framesLeft = await describe(before.slice(shared).reverse());
  const framesEntered = await describe(after.slice(shared));
  return {
    ...(framesLeft.length ? { framesLeft } : {}),
    ...(framesEntered.length ? { framesEntered } : {})
  };
}

/** A frame as its element names it: its path, and its accessible name from the browser's tree. */
async function describeFrame(
  page: PageSessions,
  dom: CapturedDom,
  frameId: string
): Promise<VirtualScreenReaderFrame> {
  const { parentFrameId, ownerBackendNodeId } = frameById(page, frameId);
  const owner =
    parentFrameId && ownerBackendNodeId !== undefined
      ? { frameId: parentFrameId, backendNodeId: ownerBackendNodeId }
      : undefined;
  const element = owner && dom.element(owner);
  const name = owner && textValue((await fetchAccessibilityNode(page, owner))?.name);
  return {
    frameId,
    framePath: element ? [...element.framePath, element.nodePath] : [],
    ...(name ? { name } : {})
  };
}

function roleOf(node: AccessibilityNode | undefined): string {
  return spokenRoleOf(textValue(node?.role) ?? "generic");
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

function cloneFrame(frame: VirtualScreenReaderFrame): VirtualScreenReaderFrame {
  return { ...frame, framePath: [...frame.framePath] };
}

function cloneFocus(focus: VirtualScreenReaderFocus): VirtualScreenReaderFocus {
  return { ...focus, ...(focus.framePath ? { framePath: [...focus.framePath] } : {}) };
}

function cloneItem(item: VirtualScreenReaderItem): VirtualScreenReaderItem {
  return {
    ...item,
    states: [...item.states],
    ...(item.framePath ? { framePath: [...item.framePath] } : {}),
    ...(item.properties ? { properties: structuredClone(item.properties) } : {}),
    ...(item.visualBounds ? { visualBounds: { ...item.visualBounds } } : {})
  };
}

function cloneEntry(entry: VirtualScreenReaderEntry): VirtualScreenReaderEntry {
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    command: entry.command,
    announcement: entry.announcement,
    ...(entry.framesLeft ? { framesLeft: entry.framesLeft.map(cloneFrame) } : {}),
    ...(entry.framesEntered ? { framesEntered: entry.framesEntered.map(cloneFrame) } : {}),
    ...(entry.item ? { item: cloneItem(entry.item) } : {}),
    ...(entry.domFocusBefore ? { domFocusBefore: cloneFocus(entry.domFocusBefore) } : {}),
    ...(entry.domFocusAfter ? { domFocusAfter: cloneFocus(entry.domFocusAfter) } : {}),
    focusMoved: entry.focusMoved
  };
}

/** The element that has DOM focus, in whichever frame's document holds it. */
async function focusedNode(reading: Reading): Promise<DomNodeRef | undefined> {
  return (await focusPath(reading.page, (frame) => reading.document(frame))).at(-1);
}

/** The focused element as the DOM snapshot names it, the way an item names its element. */
function focusAt(
  dom: CapturedDom,
  node: DomNodeRef | undefined
): VirtualScreenReaderFocus | undefined {
  const element = node && dom.element(node);
  return (
    element && {
      nodePath: element.nodePath,
      backendDOMNodeId: element.backendNodeId,
      frameId: element.frameId,
      ...(element.framePath.length ? { framePath: [...element.framePath] } : {})
    }
  );
}

/** A DOM node across frames: node ids repeat in frames rendered in other processes. */
function nodeKey(node: DomNodeRef | undefined): string | undefined {
  return node && `${node.frameId}\u0000${node.backendNodeId}`;
}
