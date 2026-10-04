import { PNG } from "pngjs";

import { describeFocusedElement, withCdpSession, type CdpSession } from "./accessibility-tree";
import { findHeadingLookalikes } from "./heading-lookalikes";
import { comparePointerAndKeyboardOutcomes } from "./pointer-keyboard-comparison";
import { trackOpenRequests, waitForQuietPage, type OpenRequests } from "./quiet-page";

/**
 * A sweep finds keyboard and pointer problems on a page without any authored steps:
 * - pointer-only: a mouse can click it, but the keyboard never reaches it;
 * - hover-only: content a hover reveals, which keyboard focus does not;
 * - activation-differs: pressing a control by keyboard does not do what clicking it does;
 * - focus-lost: after pressing a control by keyboard, focus is on nothing visible;
 * - looks-like-heading: text styled like a heading that the accessibility tree does not expose as
 *   one, so the screen reader's heading key skips it;
 * - status-not-announced: text a press makes appear that a screen reader does not say, as it is
 *   in no live region and focus did not move to it;
 * - failure-not-announced: a request a press sends fails, and the page shows and says nothing;
 * - colour-only: one of a row of like items, such as links in a menu, stands out from the others
 *   by colour alone;
 * - text-in-image: an image shaped like a line of text, named in words and drawn in two flat
 *   colours, as words drawn as pixels are.
 */
export type SweepFindingKind =
  | "pointer-only"
  | "hover-only"
  | "activation-differs"
  | "focus-lost"
  | "looks-like-heading"
  | "status-not-announced"
  | "failure-not-announced"
  | "colour-only"
  | "text-in-image";

/** The remediation-registry concept each kind of finding belongs to. */
export const SWEEP_FINDING_CONCEPTS = {
  "pointer-only": "keyboard-operation",
  "hover-only": "hover-focus-equivalence",
  "activation-differs": "keyboard-operation",
  "focus-lost": "focus-management",
  "looks-like-heading": "heading-structure",
  "status-not-announced": "status-messages",
  "failure-not-announced": "status-messages",
  "colour-only": "use-of-color",
  "text-in-image": "images-of-text"
} as const satisfies Record<SweepFindingKind, string>;

export interface SweepFinding {
  kind: SweepFindingKind;
  concept: (typeof SWEEP_FINDING_CONCEPTS)[SweepFindingKind];
  selector: string;
  label: string;
  summary: string;
}

/** One timed step of the sweep: a Tab, the hover checks, or pressing one control. */
export interface SweepStep {
  label: string;
  startedAt: string;
  finishedAt: string;
}

/** A Tab stop, in the order Tab reached it. */
export interface SweepTabStop {
  selector: string;
  /** Its accessible name, which a screen reader announces when Tab reaches it. */
  label: string;
  /** Its role in the accessibility tree. */
  role?: string;
  /**
   * Whether the stop and its surroundings look different with keyboard focus than without it,
   * compared pixel for pixel. Absent when it could not be measured.
   */
  focusVisible?: boolean;
  /** A PNG of the stop and its surroundings with keyboard focus, as a keyboard user saw it. */
  focusedCrop?: Uint8Array;
}

export interface KeyboardPointerSweepResult {
  url: string;
  tabStops: SweepTabStop[];
  /** Controls pressed to compare keyboard and pointer; empty unless activation was allowed. */
  activated: string[];
  findings: SweepFinding[];
}

/** Clicks and presses go through the locator, so Playwright waits for any page load they start. */
export interface KeyboardPointerSweepLocator {
  hover(): Promise<void>;
  focus(): Promise<void>;
  click(): Promise<void>;
  press(key: string): Promise<void>;
}

/** A Chrome DevTools session; stylesheet text is read through it because pages cannot read
 * the rules of cross-origin (and file://) stylesheets themselves. */
export interface KeyboardPointerSweepCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(
    event: "CSS.styleSheetAdded",
    listener: (event: { header: { styleSheetId: string } }) => void
  ): unknown;
  detach(): Promise<void>;
}

export interface KeyboardPointerSweepRequest {
  method(): string;
  resourceType(): string;
  failure(): { errorText: string } | null;
}

export interface KeyboardPointerSweepResponse {
  status(): number;
  request(): KeyboardPointerSweepRequest;
}

export interface KeyboardPointerSweepPage {
  context(): { newCDPSession(page: unknown): Promise<KeyboardPointerSweepCdpSession> };
  /** Playwright's page screenshot: the sweep cuts each Tab stop's frame from a viewport capture. */
  screenshot(options: {
    fullPage?: boolean;
    path?: string;
    animations?: "disabled";
    caret?: "hide";
    timeout?: number;
  }): Promise<Uint8Array>;
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  isClosed(): boolean;
  waitForLoadState(): Promise<void>;
  evaluate<Result, Arg>(
    pageFunction: (arg: Arg) => Result | Promise<Result>,
    arg: Arg
  ): Promise<Result>;
  locator(selector: string): KeyboardPointerSweepLocator;
  /** The requests a press sends are watched for one that fails. */
  on(event: "response", listener: (response: KeyboardPointerSweepResponse) => void): unknown;
  on(event: "requestfailed", listener: (request: KeyboardPointerSweepRequest) => void): unknown;
  off(event: "response", listener: (response: KeyboardPointerSweepResponse) => void): unknown;
  off(event: "requestfailed", listener: (request: KeyboardPointerSweepRequest) => void): unknown;
  /** The requests the page has open are waited for before it is read. */
  on(event: "request", listener: (request: KeyboardPointerSweepRequest) => void): unknown;
  on(event: "requestfinished", listener: (request: KeyboardPointerSweepRequest) => void): unknown;
  off(event: "request", listener: (request: KeyboardPointerSweepRequest) => void): unknown;
  off(event: "requestfinished", listener: (request: KeyboardPointerSweepRequest) => void): unknown;
  keyboard: { press(key: string): Promise<void> };
  mouse: { move(x: number, y: number): Promise<void> };
}

export interface KeyboardPointerSweepOptions {
  page: KeyboardPointerSweepPage;
  url: string;
  /**
   * Press each in-page control by keyboard and by pointer. This changes page state (it could
   * archive or delete real data), so callers opt in only where that is safe. Links and form
   * submit buttons are never pressed.
   */
  activateControls: boolean;
  maxTabStops?: number;
  /** Called as each step finishes, so a recording of the sweep can say what it shows. */
  onStep?: (step: SweepStep) => void;
}

type ProbeRequest =
  | { mode: "active"; within?: string }
  | { mode: "composite-stops"; selectors: string[]; tabStops: string[] }
  | { mode: "focus"; selector: string }
  | { mode: "pointer-only"; tabStops: string[] }
  | { mode: "hover-rules"; styleSheets: string[] }
  | { mode: "visible"; selector: string }
  | { mode: "pressable"; tabStops: string[] }
  | { mode: "outcome"; selector: string }
  | { mode: "watch-changes"; selector?: string }
  | { mode: "pressed" }
  | { mode: "new-text" }
  | { mode: "document" }
  | { mode: "focus-lost"; document: number }
  | { mode: "frame"; selector: string; margin?: number }
  | { mode: "blur" }
  | { mode: "start-at-top" }
  | { mode: "focusable" }
  | { mode: "colour-only" }
  | { mode: "text-images" }
  | { mode: "scroll-to"; x: number; y: number };

/** A region of the viewport around a Tab stop, and the scroll position it was taken at. */
interface FocusFrame {
  scrollX: number;
  scrollY: number;
  /** In CSS pixels. */
  clip: { x: number; y: number; width: number; height: number };
  /** Device pixels per CSS pixel, the scale of a viewport capture. */
  pixelRatio: number;
}

interface ProbedElement {
  selector: string;
  label: string;
}

interface HoverRule {
  hover: string;
  revealed: string;
}

interface PressableControl extends ProbedElement {
  key: "Enter" | "Space";
}

/** How a press reached its control: a click, or the key pressed on it. */
type PressTrigger = "click" | "Enter" | "Space";

/**
 * The text a press showed: the control pressed and how, how many of its new elements a screen
 * reader says, and those it does not. Null when nothing was pressed, or when the press loaded a
 * page or changed the control's own state, which a screen reader says itself.
 */
type NewText = {
  control: ProbedElement;
  trigger?: PressTrigger;
  said: number;
  unsaid: ProbedElement[];
} | null;

/** An item that stands out from its like neighbours by colour alone. */
interface ColourOnlyItem extends ProbedElement {
  neighbours: number;
  /** The colours that differ, as "property: its value instead of theirs". */
  differences: string[];
  /** The state the item is marked with, such as aria-current="page", when it has one. */
  state?: string;
}

interface ActivationOutcome {
  url: string;
  text: string;
  states: Record<string, string | null>;
}

/** Runs every keyboard and pointer check on one page, resetting it between checks. */
export async function sweepKeyboardAndPointer(
  options: KeyboardPointerSweepOptions
): Promise<KeyboardPointerSweepResult> {
  // Counted from before the first load, so the page is read once the data it loads has arrived.
  const openRequests = trackOpenRequests(options.page);
  try {
    return await sweepPage(options, openRequests);
  } finally {
    openRequests.stop();
  }
}

async function sweepPage(
  options: KeyboardPointerSweepOptions,
  openRequests: OpenRequests
): Promise<KeyboardPointerSweepResult> {
  const { page, url, onStep } = options;
  // A press can load another page while the page is being read: read the page it loaded.
  const onLoadedPage = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (page.isClosed() || !/Execution context was destroyed/.test(String(error))) throw error;
      await page.waitForLoadState();
      return read();
    }
  };
  const probe = <T>(request: ProbeRequest): Promise<T> =>
    onLoadedPage(async () => (await page.evaluate(runSweepProbe, request)) as T);
  const settle = () => onLoadedPage(() => waitForQuietPage(page, openRequests));
  const loadPage = () => loadAfresh(page, url, openRequests);

  await loadPage();
  const findings: SweepFinding[] = (
    await withCdpSession(page.context(), page, findHeadingLookalikes)
  ).map(({ selector, text, fontSize, fontWeight, bodyFontSize, bodyFontWeight }) =>
    sweepFinding(
      "looks-like-heading",
      { selector, label: text },
      `Styled like a heading (${fontSize}px, weight ${fontWeight}, against body text at ${bodyFontSize}px, weight ${bodyFontWeight}), but the accessibility tree does not expose it as a heading.`
    )
  );
  for (const item of await probe<ColourOnlyItem[]>({ mode: "colour-only" })) {
    const marked = item.state
      ? ` It is marked ${item.state}, so a screen reader says it, but a person who cannot tell these colours apart does not see it.`
      : "";
    findings.push(
      sweepFinding(
        "colour-only",
        item,
        `Stands out from its ${item.neighbours} neighbours by colour alone (${item.differences.join("; ")}); no weight, underline, border, icon or other cue tells it apart.${marked}`
      )
    );
  }
  findings.push(...(await textImages(page, probe)));
  const tabStops = await withCdpSession(page.context(), page, (session) =>
    collectTabStops(page, session, probe, options.maxTabStops ?? 200, onStep)
  );
  // Tab reaching nothing on a page with controls it reaches natively says the walk did not happen,
  // not that every control is mouse-only, so the sweep decides nothing.
  const focusable = tabStops.length ? 0 : await probe<number>({ mode: "focusable" });
  if (focusable > 0) {
    throw new Error(
      `Tab reached nothing, though the page has ${focusable} ${focusable === 1 ? "control" : "controls"} the keyboard reaches without a script, such as links and buttons. Either the page was not ready or a script stops Tab, so which controls work with a mouse only is not decided; try the page by keyboard.`
    );
  }
  const stopSelectors = tabStops.map(({ selector }) => selector);

  for (const target of await pointerOnlyTargets(page, probe, loadPage, stopSelectors, onStep)) {
    findings.push(
      sweepFinding(
        "pointer-only",
        target,
        "A mouse can click it, but pressing Tab never reaches it."
      )
    );
  }

  const styleSheets = await readStyleSheetTexts(page);
  const hoverRules = await probe<HoverRule[]>({ mode: "hover-rules", styleSheets });
  await timed(
    onStep,
    () =>
      hoverRules.length ? "Hover each element that shows more on hover, then try the keyboard" : "",
    async () => {
      for (const rule of hoverRules) {
        const revealed = await revealedOnHover(page, probe, rule);
        if (revealed.length === 0) continue;
        if (await revealedOnFocus(page, probe, rule, revealed, stopSelectors)) continue;
        findings.push(
          sweepFinding(
            "hover-only",
            { selector: rule.hover, label: revealed.join(" ") },
            "Hovering shows this content; keyboard focus never does."
          )
        );
      }
    }
  );

  const activated: string[] = [];
  if (options.activateControls) {
    await loadPage();
    for (const control of await probe<PressableControl[]>({
      mode: "pressable",
      tabStops: stopSelectors
    })) {
      activated.push(control.selector);
      findings.push(
        ...(await timed(
          onStep,
          () => `Press ${describeElement(control)} with ${control.key}, then click it`,
          () => pressControl(page, probe, settle, loadPage, control)
        ))
      );
    }
  }

  return { url, tabStops, activated, findings };
}

/** The keys that move focus inside a composite widget, whichever way it is laid out. */
const COMPOSITE_KEYS = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
/** At most this many items are walked in one widget, as `maxTabStops` bounds the Tab walk. */
const MAX_COMPOSITE_ITEMS = 100;

/**
 * Mouse targets no key reaches. Tabs, a menu, a listbox, a tree, a grid, a radio group or a toolbar
 * is one Tab stop, and its arrow keys, Home and End move focus inside it, as the APG patterns ask.
 * So before a target inside one is reported, those keys are pressed from its Tab stop, from every
 * item they reach. They move focus and, in some widgets, the selection; Enter and Space are never
 * pressed, and the page is loaded again afterwards.
 */
async function pointerOnlyTargets(
  page: KeyboardPointerSweepPage,
  probe: <T>(request: ProbeRequest) => Promise<T>,
  loadPage: () => Promise<void>,
  tabStops: string[],
  onStep: KeyboardPointerSweepOptions["onStep"]
): Promise<ProbedElement[]> {
  const targets = await probe<ProbedElement[]>({ mode: "pointer-only", tabStops });
  const widgets = await probe<Array<{ widget: string; stop: string }>>({
    mode: "composite-stops",
    selectors: targets.map(({ selector }) => selector),
    tabStops
  });
  if (widgets.length === 0) return targets;
  const reached = await timed(
    onStep,
    () => "From each widget's Tab stop, press the arrow keys, Home and End",
    async () => {
      const items: string[] = [];
      for (const { widget, stop } of widgets) {
        items.push(...(await walkComposite(page, probe, widget, stop)));
      }
      return items;
    }
  );
  await loadPage();
  return probe<ProbedElement[]>({ mode: "pointer-only", tabStops: [...tabStops, ...reached] });
}

/** Every item of one widget its keys reach, starting from its Tab stop. */
async function walkComposite(
  page: KeyboardPointerSweepPage,
  probe: <T>(request: ProbeRequest) => Promise<T>,
  widget: string,
  stop: string
): Promise<string[]> {
  const reached = [stop];
  for (let index = 0; index < reached.length && reached.length < MAX_COMPOSITE_ITEMS; index += 1) {
    for (const key of COMPOSITE_KEYS) {
      // By script, not by locator, which waits for an item a key removed, such as a closed menu's.
      if (!(await probe<boolean>({ mode: "focus", selector: reached[index]! }))) break;
      await page.keyboard.press(key);
      const active = await probe<ProbedElement | null>({ mode: "active", within: widget });
      if (active && !reached.includes(active.selector)) reached.push(active.selector);
    }
  }
  return reached;
}

/**
 * Loads the page at its address again, as it first loaded, and waits for the app to draw it: a
 * check that reads it before then sees an empty page. Going to an address with a #fragment only
 * scrolls to the fragment when the page is already there, keeping whatever a check changed, so
 * such an address is reloaded.
 */
async function loadAfresh(
  page: KeyboardPointerSweepPage,
  url: string,
  openRequests: OpenRequests
): Promise<void> {
  await page.goto(url);
  if (new URL(url).hash) await page.reload();
  await waitForQuietPage(page, openRequests);
}

async function readStyleSheetTexts(page: KeyboardPointerSweepPage): Promise<string[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const ids: string[] = [];
    session.on("CSS.styleSheetAdded", ({ header }) => ids.push(header.styleSheetId));
    await session.send("DOM.enable");
    // Enabling the CSS domain reports every stylesheet already on the page.
    await session.send("CSS.enable");
    const texts: string[] = [];
    for (const styleSheetId of ids) {
      const response = (await session.send("CSS.getStyleSheetText", { styleSheetId })) as {
        text: string;
      };
      texts.push(response.text);
    }
    return texts;
  } finally {
    await session.detach();
  }
}

/** How a step names an element: by its label, or as unnamed, which is itself worth seeing. */
function describeElement({ selector, label }: ProbedElement): string {
  return label ? `“${label}”` : `a control with no name (${selector})`;
}

/** Runs `run`, then reports it as a step unless `label` names none. */
async function timed<Result>(
  onStep: KeyboardPointerSweepOptions["onStep"],
  label: (result: Result) => string,
  run: () => Promise<Result>
): Promise<Result> {
  const startedAt = new Date().toISOString();
  const result = await run();
  const text = label(result);
  if (text) onStep?.({ label: text, startedAt, finishedAt: new Date().toISOString() });
  return result;
}

/**
 * Presses Tab from the top of the page until focus returns to a stop already reached, capturing
 * each stop's surroundings with focus. Then, with focus on nothing, it captures the same regions
 * again: focus is visible where the two differ, which is what WCAG 2.4.7 asks for.
 */
async function collectTabStops(
  page: KeyboardPointerSweepPage,
  session: CdpSession,
  probe: <T>(request: ProbeRequest) => Promise<T>,
  maxTabStops: number,
  onStep: KeyboardPointerSweepOptions["onStep"]
): Promise<SweepTabStop[]> {
  const stops: Array<SweepTabStop & { frame: FocusFrame | null }> = [];
  const isNewStop = (active: SweepTabStop | null): active is SweepTabStop =>
    active !== null && !stops.some(({ selector }) => selector === active.selector);
  await probe({ mode: "start-at-top" });
  for (let index = 0; index < maxTabStops; index += 1) {
    const active = await timed(
      onStep,
      (found) => (isNewStop(found) ? `Tab ${stops.length + 1}: ${describeElement(found)}` : ""),
      async (): Promise<SweepTabStop | null> => {
        await page.keyboard.press("Tab");
        const element = await probe<ProbedElement | null>({ mode: "active" });
        const described = element && (await describeFocusedElement(session));
        return element && described
          ? { selector: element.selector, label: described.name, role: described.role }
          : element;
      }
    );
    if (!isNewStop(active)) break;
    const frame = await probe<FocusFrame | null>({ mode: "frame", selector: active.selector });
    const focusedCrop = frame ? await captureFrame(page, frame) : undefined;
    stops.push({ ...active, frame, ...(focusedCrop ? { focusedCrop } : {}) });
  }
  await probe({ mode: "blur" });
  const measured: SweepTabStop[] = [];
  for (const { frame, ...stop } of stops) {
    if (frame && stop.focusedCrop) {
      await probe({ mode: "scroll-to", x: frame.scrollX, y: frame.scrollY });
      const unfocused = await captureFrame(page, frame);
      if (unfocused) stop.focusVisible = visiblyDifferent(stop.focusedCrop, unfocused);
    }
    measured.push(stop);
  }
  return measured;
}

/** A colour channel moving by more than this, out of 255, is a change a person could see. */
const VISIBLE_CHANNEL_CHANGE = 32;
/** Fewer changed pixels than this are rendering noise, not an indicator. */
const VISIBLE_PIXEL_COUNT = 4;

/**
 * Whether two captures of one frame look different. Rendering noise, such as a corner's
 * anti-aliasing shifting by a shade between captures, stays below the thresholds.
 */
function visiblyDifferent(first: Uint8Array, second: Uint8Array): boolean {
  const [one, two] = [first, second].map((png) => PNG.sync.read(Buffer.from(png)));
  if (one!.width !== two!.width || one!.height !== two!.height) return true;
  let changed = 0;
  for (let index = 0; index < one!.data.length; index += 1) {
    if (Math.abs(one!.data[index]! - two!.data[index]!) <= VISIBLE_CHANNEL_CHANGE) continue;
    changed += 1;
    if (changed >= VISIBLE_PIXEL_COUNT) return true;
    // Count each pixel once, whichever of its channels moved.
    index += 3 - (index % 4);
  }
  return false;
}

/**
 * A PNG of one frame, with animations finished and the text caret hidden so that only focus can
 * change it. A capture that times out leaves that stop unmeasured rather than stopping the sweep.
 * The frame is cut from a capture of the whole viewport: Chromium's screencast, which a recording
 * of the sweep is made from, shows a clipped capture for that moment instead of the page.
 */
async function captureFrame(
  page: KeyboardPointerSweepPage,
  { clip, pixelRatio }: FocusFrame
): Promise<Uint8Array | undefined> {
  let viewport: Uint8Array;
  try {
    viewport = await page.screenshot({ animations: "disabled", caret: "hide", timeout: 5_000 });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return undefined;
    throw error;
  }
  const source = PNG.sync.read(Buffer.from(viewport));
  const x = Math.round(clip.x * pixelRatio);
  const y = Math.round(clip.y * pixelRatio);
  const frame = new PNG({
    width: Math.min(Math.round(clip.width * pixelRatio), source.width - x),
    height: Math.min(Math.round(clip.height * pixelRatio), source.height - y)
  });
  PNG.bitblt(source, frame, x, y, frame.width, frame.height, 0, 0);
  return PNG.sync.write(frame);
}

/**
 * Words drawn as pixels sit on a plain background: in an image of text, two colours, the
 * background and the letters, cover most of it, where a photograph or a gradient spreads over
 * many. Colours are counted at 4 bits a channel, so the letters' smoothed edges do not count as
 * colours of their own, and an image of one colour shows nothing.
 */
const FLAT_TWO_COLOURS = 0.6;
const MOSTLY_ONE_COLOUR = 0.97;

/** Images that may be words drawn as pixels: candidates by shape and name, then by their pixels. */
async function textImages(
  page: KeyboardPointerSweepPage,
  probe: <T>(request: ProbeRequest) => Promise<T>
): Promise<SweepFinding[]> {
  const findings: SweepFinding[] = [];
  for (const image of await probe<ProbedElement[]>({ mode: "text-images" })) {
    const frame = await probe<FocusFrame | null>({
      mode: "frame",
      selector: image.selector,
      margin: 0
    });
    const crop = frame ? await captureFrame(page, frame) : undefined;
    if (!crop || !drawnInTwoFlatColours(PNG.sync.read(Buffer.from(crop)))) continue;
    findings.push(
      sweepFinding(
        "text-in-image",
        image,
        "An image shaped like a line of text, named in words and drawn in two flat colours, as words drawn as pixels are. If its words are pixels, they cannot be resized, recoloured or translated, and they blur when zoomed; a logo is exempt."
      )
    );
  }
  await probe({ mode: "scroll-to", x: 0, y: 0 });
  return findings;
}

function drawnInTwoFlatColours(image: PNG): boolean {
  const counts = new Map<number, number>();
  for (let at = 0; at < image.data.length; at += 4) {
    const colour =
      ((image.data[at]! >> 4) << 8) |
      ((image.data[at + 1]! >> 4) << 4) |
      (image.data[at + 2]! >> 4);
    counts.set(colour, (counts.get(colour) ?? 0) + 1);
  }
  const pixels = image.width * image.height;
  const [first = 0, second = 0] = [...counts.values()].sort((a, b) => b - a);
  return first / pixels < MOSTLY_ONE_COLOUR && (first + second) / pixels >= FLAT_TWO_COLOURS;
}

/** The text of the content that hovering the rule's element makes visible. */
async function revealedOnHover(
  page: KeyboardPointerSweepPage,
  probe: <T>(request: ProbeRequest) => Promise<T>,
  rule: HoverRule
): Promise<string[]> {
  await page.mouse.move(0, 0);
  const before = await probe<string[]>({ mode: "visible", selector: rule.revealed });
  await page.locator(rule.hover).hover();
  const after = await probe<string[]>({ mode: "visible", selector: rule.revealed });
  await page.mouse.move(0, 0);
  return after.filter((label) => !before.includes(label));
}

/** Whether focusing any tab stop makes the same content visible. */
async function revealedOnFocus(
  page: KeyboardPointerSweepPage,
  probe: <T>(request: ProbeRequest) => Promise<T>,
  rule: HoverRule,
  revealed: string[],
  tabStops: string[]
): Promise<boolean> {
  for (const stop of tabStops) {
    await page.locator(stop).focus();
    const visible = await probe<string[]>({ mode: "visible", selector: rule.revealed });
    if (revealed.some((label) => visible.includes(label))) return true;
  }
  return false;
}

async function pressControl(
  page: KeyboardPointerSweepPage,
  probe: <T>(request: ProbeRequest) => Promise<T>,
  settle: () => Promise<void>,
  loadPage: () => Promise<void>,
  control: PressableControl
): Promise<SweepFinding[]> {
  const findings: SweepFinding[] = [];
  const target = page.locator(control.selector);
  let loadedDocument = 0;
  // What the keyboard press did, read as it happens.
  const pressed: { focusLost: boolean; newText: NewText; failedRequests: string[] } = {
    focusLost: false,
    newText: null,
    failedRequests: []
  };
  // Each press is read once the page has settled, so a result that comes a moment later, such as
  // a message after a request, counts the same for keyboard and mouse.
  const comparison = await comparePointerAndKeyboardOutcomes<ActivationOutcome>({
    reset: async () => {
      await loadPage();
      loadedDocument = await probe<number>({ mode: "document" });
    },
    performPointerInteraction: async () => {
      await target.click();
      await settle();
    },
    performKeyboardInteraction: async () => {
      await probe({ mode: "watch-changes", selector: control.selector });
      pressed.failedRequests = await failedRequestsDuring(page, async () => {
        await target.press(control.key);
        await settle();
      });
      pressed.focusLost = await probe<boolean>({ mode: "focus-lost", document: loadedDocument });
      pressed.newText = await probe<NewText>({ mode: "new-text" });
    },
    captureOutcome: () => probe<ActivationOutcome>({ mode: "outcome", selector: control.selector })
  });
  if (comparison.verdict === "fail") {
    findings.push(
      sweepFinding(
        "activation-differs",
        control,
        `Pressing ${control.key} does not do what clicking does.`
      )
    );
  }
  if (pressed.focusLost) {
    findings.push(
      sweepFinding(
        "focus-lost",
        control,
        `After pressing ${control.key}, focus is left on nothing visible.`
      )
    );
  }
  findings.push(...unheardResults(pressed.newText, pressed.failedRequests, control.key));
  return findings;
}

/**
 * What a press showed or failed to do that a screen reader user does not hear: new text in no
 * live region, and a failed request the page says nothing about.
 */
function unheardResults(
  newText: NewText,
  failedRequests: string[],
  trigger = newText?.trigger
): SweepFinding[] {
  if (!newText) return [];
  const { control } = newText;
  const how =
    trigger === "click"
      ? `Clicking ${describeElement(control)}`
      : `Pressing ${describeElement(control)} with ${trigger}`;
  const findings = newText.unsaid.map((message) =>
    sweepFinding(
      "status-not-announced",
      message,
      `${how} shows this text, but a screen reader does not say it: it is in no live region that was on the page before, and focus did not move to it.`
    )
  );
  // A message the page shows but does not say is reported above; here the page shows nothing.
  if (failedRequests.length > 0 && newText.said === 0 && newText.unsaid.length === 0) {
    findings.push(
      sweepFinding(
        "failure-not-announced",
        control,
        `${how} sends a request that fails (${failedRequests.join("; ")}), and the page shows and says nothing about it.`
      )
    );
  }
  return findings;
}

/** A page whose own presses, made by a test, can be read. */
export type PressObservingPage = Pick<KeyboardPointerSweepPage, "evaluate" | "on" | "off">;

/** What one of a test's own actions did, when it pressed a control. */
export interface ObservedPress<Result> {
  /** What the action returned. */
  result: Result;
  /** Whether the action pressed a control: clicked it, or pressed Enter or Space on it. */
  pressed: boolean;
  findings: SweepFinding[];
  /** Why the page could not be read after the press, when it could not. */
  unreadable?: string;
}

/**
 * Runs an action a test takes and, if it presses a control, reads what the press showed once the
 * page has settled, as the sweep reads its own presses: so a test's clicks are checked on an app
 * the sweep may not press. Nothing is pressed that the test did not press. The action's own error
 * is the test's and is thrown as it is; one reading the page is returned, never thrown, so it
 * never fails the test.
 */
export async function observePress<Result>(
  page: PressObservingPage,
  openRequests: OpenRequests | undefined,
  action: () => Promise<Result>
): Promise<ObservedPress<Result>> {
  const probe = async <T>(request: ProbeRequest) =>
    (await page.evaluate(runSweepProbe, request)) as T;
  let unreadable: string | undefined;
  const read = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      // A press that loads another page, or closes this one, leaves nothing of its result to read.
      if (!/Execution context was destroyed|has been closed|detached/.test(String(error))) {
        unreadable ??= error instanceof Error ? error.message : String(error);
      }
      return undefined;
    }
  };
  const watching = (await read(() => probe({ mode: "watch-changes" }))) !== undefined;
  let result!: Result;
  let pressed = false;
  const failedRequests = await failedRequestsDuring(page, async () => {
    result = await action();
    pressed = watching && Boolean(await read(() => probe<boolean>({ mode: "pressed" })));
    if (pressed) await read(() => waitForQuietPage(page, openRequests));
  });
  const newText = watching ? await read(() => probe<NewText>({ mode: "new-text" })) : undefined;
  return {
    result,
    pressed,
    findings: pressed ? unheardResults(newText ?? null, failedRequests) : [],
    ...(unreadable ? { unreadable } : {})
  };
}

/**
 * The requests that fail while `run` runs: an error status, or no response at all. Only requests a
 * script sends count, as a save or a load does; a missing image is no action's result. A request
 * the page cancelled, as a page load does to the requests still open, did not fail. Each is named
 * by its method and outcome, never its address, which can carry personal data.
 */
async function failedRequestsDuring(
  page: PressObservingPage,
  run: () => Promise<void>
): Promise<string[]> {
  const failed: string[] = [];
  const sentByScript = (request: KeyboardPointerSweepRequest) =>
    request.resourceType() === "fetch" || request.resourceType() === "xhr";
  const onResponse = (response: KeyboardPointerSweepResponse) => {
    if (response.status() >= 400 && sentByScript(response.request())) {
      failed.push(`${response.request().method()}, status ${response.status()}`);
    }
  };
  const onFailed = (request: KeyboardPointerSweepRequest) => {
    const cancelled = /ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(
      request.failure()?.errorText ?? ""
    );
    if (sentByScript(request) && !cancelled) failed.push(`${request.method()}, no response`);
  };
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  try {
    await run();
  } finally {
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
  }
  return failed;
}

function sweepFinding(
  kind: SweepFindingKind,
  { selector, label }: ProbedElement,
  summary: string
): SweepFinding {
  return { kind, concept: SWEEP_FINDING_CONCEPTS[kind], selector, label, summary };
}

/**
 * Runs inside the page, so it must be self-contained: Playwright serializes it and nothing
 * from this module's scope is available there.
 */
function runSweepProbe(request: ProbeRequest): unknown {
  const selectorFor = (element: Element): string => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parent = element.parentElement;
    if (!parent) return element.tagName.toLowerCase();
    const sameTag = [...parent.children].filter((child) => child.tagName === element.tagName);
    const position = sameTag.indexOf(element) + 1;
    return `${selectorFor(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${position})`;
  };
  const labelFor = (element: Element): string =>
    (
      element.getAttribute("aria-label") ??
      (element as HTMLElement).innerText ??
      element.textContent ??
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);
  const isVisible = (element: Element): boolean =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  // A mouse can only reach what lies on the page. A skip link parked above the top until it has
  // focus is visible to the browser, yet no pointer can hover it.
  const onPage = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const root = document.documentElement;
    return (
      box.right + scrollX > 0 &&
      box.bottom + scrollY > 0 &&
      box.left + scrollX < root.scrollWidth &&
      box.top + scrollY < root.scrollHeight
    );
  };
  const find = (selectors: string[]) =>
    selectors
      .map((selector) => document.querySelector(selector))
      .filter((element): element is Element => element !== null);
  // A control's own state, which a screen reader says as it changes: expanded, pressed, checked,
  // including a native check box's or radio button's, which no attribute shows.
  const statesOf = (element: Element | null): Record<string, string | null> => ({
    ...Object.fromEntries(
      ["aria-expanded", "aria-pressed", "aria-checked", "open"].map((name) => [
        name,
        element?.getAttribute(name) ?? null
      ])
    ),
    checked: element instanceof HTMLInputElement ? String(element.checked) : null
  });
  // The controls a press acts on. Links are left out: they go to another page.
  const pressableControls =
    "button, summary, [role=button], [role=switch], [role=checkbox], input[type=checkbox], input[type=radio]";
  // Text compared across a press, as the page shows it or as its nodes hold it, which differ in
  // spacing and in case a style transforms.
  const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  // What a press changed, recorded from just before it; "new-text" reads and ends it. A watch with
  // no control yet waits for the press, which a test makes, to reach one.
  const watchKey = Symbol.for("aee.sweep.watch-changes");
  interface ChangeWatch {
    selector: string;
    /** The control's name as the press reached it, which the press may change or remove. */
    label: string;
    trigger?: "click" | "Enter" | "Space";
    url: string;
    text: string;
    states: Record<string, string | null>;
    liveRegions: Element[];
    changed: Set<Element>;
    observer: MutationObserver;
  }
  interface PressWatch {
    watch?: ChangeWatch;
    stop(): void;
  }
  const store = globalThis as unknown as Record<symbol, PressWatch | undefined>;
  const startWatch = (selector: string, trigger?: ChangeWatch["trigger"]): ChangeWatch => {
    const control = document.querySelector(selector);
    const changed = new Set<Element>();
    // An attribute change shows new text only by showing an element that was hidden; on one
    // already shown, such as the body getting a class, it changes no text.
    const shown = new WeakSet([...document.body.querySelectorAll("*")].filter(isVisible));
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target instanceof Element && !shown.has(record.target)) {
            changed.add(record.target);
          }
          continue;
        }
        const nodes = record.type === "childList" ? [...record.addedNodes] : [record.target];
        for (const node of nodes) {
          const element = node instanceof Element ? node : node.parentElement;
          if (element) changed.add(element);
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
    return {
      selector,
      label: control ? labelFor(control) : "",
      ...(trigger ? { trigger } : {}),
      url: location.href,
      text: normalized(document.body.innerText),
      states: statesOf(control),
      // A screen reader says a change inside a live region only if the region was on the page
      // before the change; a region added with its text is said by some and not by others.
      liveRegions: [
        ...document.querySelectorAll(
          '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], output'
        )
      ],
      changed,
      observer
    };
  };

  switch (request.mode) {
    case "active": {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      if (request.within && !document.querySelector(request.within)?.contains(active)) return null;
      return { selector: selectorFor(active), label: labelFor(active) };
    }
    // The composite widget each target sits in, with the Tab stop inside it that its arrow keys
    // start from, once per widget. A widget whose items Tab never reaches has none.
    case "composite-stops": {
      const stops = find(request.tabStops);
      const widgets = new Map<string, string>();
      for (const target of find(request.selectors)) {
        const widget = target.closest(
          '[role="tablist"], [role="menubar"], [role="menu"], [role="listbox"], [role="tree"], [role="treegrid"], [role="grid"], [role="radiogroup"], [role="toolbar"]'
        );
        const stop = widget && stops.find((element) => widget.contains(element));
        if (stop) widgets.set(selectorFor(widget), selectorFor(stop));
      }
      return [...widgets].map(([widget, stop]) => ({ widget, stop }));
    }
    // Focuses an item again, to press the next key from it: false when it is gone or cannot take it.
    case "focus": {
      const element = document.querySelector(request.selector);
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
      element.focus();
      return document.activeElement === element;
    }
    case "pointer-only": {
      // A mouse target is the outermost element showing a pointer cursor, or one with an inline
      // click handler. Listeners a framework attaches to the root are invisible in the DOM; the
      // pointer cursor is how those controls announce themselves to a mouse user.
      const stops = find(request.tabStops);
      const reachable = (element: Element) =>
        stops.some(
          (stop) => stop === element || stop.contains(element) || element.contains(stop)
        ) ||
        (element instanceof HTMLLabelElement && element.control !== null);
      return [...document.body.querySelectorAll("*")]
        .filter((element) => {
          const pointer =
            getComputedStyle(element).cursor === "pointer" || element.hasAttribute("onclick");
          const parent = element.parentElement;
          const parentPointer = parent !== null && getComputedStyle(parent).cursor === "pointer";
          return pointer && !parentPointer && isVisible(element) && !reachable(element);
        })
        .map((element) => ({ selector: selectorFor(element), label: labelFor(element) }));
    }
    case "hover-rules": {
      // Splits a selector list on its top-level commas, not the ones inside :is() or :not().
      const splitSelectorList = (text: string): string[] => {
        const parts: string[] = [];
        let depth = 0;
        let start = 0;
        for (let index = 0; index < text.length; index += 1) {
          if (text[index] === "(") depth += 1;
          else if (text[index] === ")") depth -= 1;
          else if (text[index] === "," && depth === 0) {
            parts.push(text.slice(start, index));
            start = index + 1;
          }
        }
        return [...parts, text.slice(start)];
      };
      const rules: Array<{ hover: string; revealed: string }> = [];
      const visit = (list: CSSRuleList) => {
        for (const rule of list) {
          if (rule instanceof CSSStyleRule) {
            for (const selector of splitSelectorList(rule.selectorText)) {
              const at = selector.indexOf(":hover");
              // Pseudo-elements (::after tooltips) cannot be queried, so they are out of reach here.
              if (at <= 0 || selector.includes("::")) continue;
              const hover = selector.slice(0, at).trim();
              const revealed = selector.replaceAll(":hover", "").trim();
              for (const element of document.querySelectorAll(hover)) {
                if (isVisible(element) && onPage(element)) {
                  rules.push({ hover: selectorFor(element), revealed });
                }
              }
            }
          } else if ("cssRules" in rule) {
            visit((rule as CSSGroupingRule).cssRules);
          }
        }
      };
      // The page's own parser reads the text; @import rules are skipped because each imported
      // sheet arrives as its own text.
      for (const text of request.styleSheets) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        visit(sheet.cssRules);
      }
      return rules;
    }
    case "visible":
      return [...document.querySelectorAll(request.selector)].filter(isVisible).map(labelFor);
    case "pressable": {
      // Links navigate away and submit buttons send forms, so neither is ever pressed.
      return find(request.tabStops)
        .filter((element) => {
          if (element.matches("a[href], input[type=text], input[type=search], textarea, select"))
            return false;
          if (element instanceof HTMLButtonElement && element.type === "submit" && element.form)
            return false;
          return element.matches(pressableControls);
        })
        .map((element) => ({
          selector: selectorFor(element),
          label: labelFor(element),
          key: element.matches(
            "input[type=checkbox], input[type=radio], [role=checkbox], [role=switch]"
          )
            ? "Space"
            : "Enter"
        }));
    }
    case "outcome":
      return {
        url: location.href,
        text: document.body.innerText,
        states: statesOf(document.querySelector(request.selector))
      };
    case "watch-changes": {
      store[watchKey]?.stop();
      const press: PressWatch = {
        stop: () => press.watch?.observer.disconnect()
      };
      store[watchKey] = press;
      if (request.selector) {
        press.watch = startWatch(request.selector);
        return null;
      }
      // A test's own press is watched from the moment it reaches a control, before the page's own
      // handlers run: a click (from its pointer going down), or Enter or Space pressed on it.
      const reached = (event: Event) => {
        if (!event.isTrusted || !(event.target instanceof Element)) return;
        const key = event instanceof KeyboardEvent ? event.key : undefined;
        if (key !== undefined && key !== "Enter" && key !== " ") return;
        const control = event.target.closest(pressableControls);
        if (!control) return;
        removeListeners();
        press.watch = startWatch(
          selectorFor(control),
          key === undefined ? "click" : key === " " ? "Space" : "Enter"
        );
      };
      const removeListeners = () => {
        removeEventListener("pointerdown", reached, true);
        removeEventListener("keydown", reached, true);
      };
      addEventListener("pointerdown", reached, true);
      addEventListener("keydown", reached, true);
      press.stop = () => {
        removeListeners();
        press.watch?.observer.disconnect();
      };
      return null;
    }
    // Whether the press being watched for has reached a control.
    case "pressed":
      return Boolean(store[watchKey]?.watch);
    // The text a press showed (see NewText). Text is said when it is in a live region that was
    // there before (or an alert, which is said as it is added) or focus moved to it. Controls are
    // left out, as their text is their name, and so are dialogs, whose focus is a check of its own.
    case "new-text": {
      const press = store[watchKey];
      delete store[watchKey];
      press?.stop();
      // No watch: the press loaded another document, or reached no control.
      const watch = press?.watch;
      if (!watch) return null;
      const control = document.querySelector(watch.selector);
      const skipped =
        'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], dialog, [role="dialog"], [role="alertdialog"], [aria-hidden="true"]';
      if (
        location.href !== watch.url ||
        JSON.stringify(statesOf(control)) !== JSON.stringify(watch.states)
      ) {
        return null;
      }
      const active = document.activeElement;
      const saidAt = (element: Element) =>
        element.closest('[role="alert"]') !== null ||
        watch.liveRegions.some((region) => region.isConnected && region.contains(element)) ||
        (active !== null &&
          active !== document.body &&
          (element.contains(active) || active.contains(element)));
      // The visible text of an element outside any control, piece by piece.
      const textParts = (element: Element) => {
        const parts: Array<{ text: string; parent: Element }> = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.trim() ?? "";
          const parent = node.parentElement;
          if (!text || !parent || parent.closest(skipped) || !isVisible(parent)) continue;
          parts.push({ text, parent });
        }
        return parts;
      };
      const fresh = [...watch.changed].filter((element) => {
        if (!element.isConnected || control?.contains(element) || element.closest(skipped)) {
          return false;
        }
        return textParts(element).some(({ text }) => !watch.text.includes(normalized(text)));
      });
      const shown = fresh.filter(
        (element) => !fresh.some((other) => other !== element && other.contains(element))
      );
      // Said when the element is, or when every piece of its text is, such as an alert inside a
      // toast that also holds an Undo button.
      const said = (element: Element) =>
        saidAt(element) || textParts(element).every(({ parent }) => saidAt(parent));
      return {
        control: { selector: watch.selector, label: watch.label },
        ...(watch.trigger ? { trigger: watch.trigger } : {}),
        said: shown.filter(said).length,
        unsaid: shown
          .filter((element) => !said(element))
          .slice(0, 5)
          .map((element) => ({ selector: selectorFor(element), label: labelFor(element) }))
      };
    }
    // Identifies the loaded document, so a check can tell whether a press loaded another one.
    case "document":
      return performance.timeOrigin;
    // Focus is lost when it falls back to the body or stays on an element no longer shown. After a
    // press loads another document, focus starting at its top is what any page load does.
    case "focus-lost": {
      if (performance.timeOrigin !== request.document) return false;
      const active = document.activeElement;
      return active === null || active === document.body || !isVisible(active);
    }
    // Centres the element in the viewport and frames it with a margin, since a focus indicator is
    // often drawn around an element rather than on it. Scrolling is instant, so the frame is taken
    // where the page settles even when the page asks for smooth scrolling.
    case "frame": {
      const element = document.querySelector(request.selector);
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const box = element.getBoundingClientRect();
      // Whole pixels, so both captures sample the page on the same pixel grid.
      const margin = request.margin ?? 12;
      const left = Math.max(0, Math.floor(box.left - margin));
      const top = Math.max(0, Math.floor(box.top - margin));
      const right = Math.min(innerWidth, Math.ceil(box.right + margin));
      const bottom = Math.min(innerHeight, Math.ceil(box.bottom + margin));
      if (right - left < 1 || bottom - top < 1) return null;
      return {
        scrollX,
        scrollY,
        clip: { x: left, y: top, width: right - left, height: bottom - top },
        pixelRatio: devicePixelRatio
      };
    }
    case "blur":
      (document.activeElement as HTMLElement | null)?.blur();
      return null;
    // Tab starts where a keyboard user starting at the top would. An address's #fragment moves the
    // starting point to its target, and blur() leaves it where focus was, so the body is focused:
    // it takes focus only with a tabindex, which it gets back as it was.
    case "start-at-top": {
      const tabIndex = document.body.getAttribute("tabindex");
      document.body.tabIndex = -1;
      document.body.focus({ preventScroll: true });
      if (tabIndex === null) document.body.removeAttribute("tabindex");
      else document.body.setAttribute("tabindex", tabIndex);
      return null;
    }
    case "scroll-to":
      scrollTo({ left: request.x, top: request.y, behavior: "instant" });
      return null;
    // One of a row of like items (list items, links, buttons, tabs, options, menu items) that
    // differs from all its neighbours, which match each other, in colour and in nothing else a
    // person could see: weight, size, underline, border, shape, an icon or text added by a style,
    // a fill or line that appears, or a change in lightness of 3:1.
    // Two exceptions: a neighbourhood whose items share one text the item lacks, as "Active,
    // Active, Inactive" pills do, says its difference in words; and a disabled item, dimmed, says
    // its state to a screen reader and is a widely accepted convention.
    case "colour-only": {
      const items =
        'li, a, button, [role="tab"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="button"], [role="link"], [role="listitem"], [role="treeitem"]';
      const colours = [
        "color",
        "background-color",
        "border-top-color",
        "border-right-color",
        "border-bottom-color",
        "border-left-color",
        "outline-color",
        "text-decoration-color",
        "fill",
        "stroke"
      ];
      const cues = [
        "display",
        "visibility",
        "content",
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "letter-spacing",
        "text-transform",
        "text-decoration-line",
        "text-decoration-style",
        "border-top-style",
        "border-right-style",
        "border-bottom-style",
        "border-left-style",
        "border-top-width",
        "border-right-width",
        "border-bottom-width",
        "border-left-width",
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-left-radius",
        "border-bottom-right-radius",
        "outline-style",
        "outline-width",
        "background-image",
        "list-style-type"
      ];
      // Any CSS colour, as the page paints it: a canvas resolves every syntax to red, green, blue
      // and alpha.
      const paint = document.createElement("canvas").getContext("2d", {
        willReadFrequently: true
      })!;
      const rgba = (colour: string) => {
        paint.clearRect(0, 0, 1, 1);
        if (colour === "none") return [0, 0, 0, 0];
        paint.fillStyle = colour;
        paint.fillRect(0, 0, 1, 1);
        return [...paint.getImageData(0, 0, 1, 1).data];
      };
      const luminance = ([red, green, blue]: number[]) => {
        const [r, g, b] = [red!, green!, blue!].map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      // A change a person sees without telling hues apart: 3:1 in lightness, the contrast WCAG's
      // technique G183 asks of a link told apart from its text by colour.
      const seenWithoutHue = (one: number[], other: number[]) => {
        const [lighter, darker] = [luminance(one), luminance(other)].sort((a, b) => b - a);
        return (lighter! + 0.05) / (darker! + 0.05) >= 3;
      };
      const withoutColours = (shadow: string) => shadow.replace(/rgba?\([^)]*\)/g, "");
      const look = (item: Element) => {
        const cue: unknown[] = [];
        const colour: Array<{ name: string; value: string; paint: number[] }> = [];
        for (const element of [item, ...item.querySelectorAll("*")]) {
          cue.push(element.tagName);
          for (const pseudo of [null, "::before", "::after"]) {
            const style = getComputedStyle(element, pseudo);
            if (pseudo && (style.content === "none" || style.content === "normal")) continue;
            const painted = colours.map((name) => ({
              name,
              value: style.getPropertyValue(name),
              paint: rgba(style.getPropertyValue(name))
            }));
            // A fill or a line that appears or goes, such as a border turning from transparent
            // to blue, is a shape, not a colour.
            cue.push(
              pseudo,
              cues.map((name) => style.getPropertyValue(name)),
              painted.map(({ paint: [, , , alpha] }) => alpha! > 0),
              withoutColours(style.boxShadow),
              withoutColours(style.textShadow)
            );
            colour.push(
              ...painted,
              { name: "opacity", value: style.opacity, paint: [] },
              { name: "box-shadow", value: style.boxShadow, paint: [] },
              { name: "text-shadow", value: style.textShadow, paint: [] }
            );
          }
        }
        return {
          cue: JSON.stringify(cue),
          colour,
          colourKey: JSON.stringify(colour.map(({ value }) => value))
        };
      };
      const textOf = (element: Element) => (element as HTMLElement).innerText.trim();
      const found: Array<{
        selector: string;
        label: string;
        neighbours: number;
        differences: string[];
        state?: string;
      }> = [];
      for (const parent of document.querySelectorAll("body, body *")) {
        const groups = new Map<string, Element[]>();
        for (const child of parent.children) {
          if (!child.matches(items) || !isVisible(child)) continue;
          const key = `${child.tagName} ${child.getAttribute("role") ?? ""}`;
          groups.set(key, [...(groups.get(key) ?? []), child]);
        }
        for (const group of groups.values()) {
          if (group.length < 3) continue;
          const looks = group.map(look);
          group.forEach((item, index) => {
            const others = looks.filter((_, other) => other !== index);
            const usual = others[0]!;
            if (
              others.some(
                ({ cue, colourKey }) => cue !== usual.cue || colourKey !== usual.colourKey
              ) ||
              looks[index]!.cue !== usual.cue ||
              looks[index]!.colourKey === usual.colourKey
            ) {
              return;
            }
            const otherTexts = new Set(group.filter((other) => other !== item).map(textOf));
            if (otherTexts.size === 1 && !otherTexts.has(textOf(item))) return;
            if (item.matches(':disabled, [aria-disabled="true"]')) return;
            if (item.querySelector(':disabled, [aria-disabled="true"]')) return;
            const changed = looks[index]!.colour.flatMap((mine, at) => {
              const theirs = usual.colour[at]!;
              return mine.value === theirs.value ? [] : [{ mine, theirs }];
            });
            if (
              changed.some(
                ({ mine, theirs }) =>
                  mine.paint.length > 0 &&
                  mine.paint[3]! > 0 &&
                  seenWithoutHue(mine.paint, theirs.paint)
              )
            ) {
              return;
            }
            const differences = changed.map(
              ({ mine, theirs }) => `${mine.name}: ${mine.value} instead of ${theirs.value}`
            );
            const marked = [item, ...item.querySelectorAll("*")]
              .flatMap((element) =>
                ["aria-current", "aria-selected", "aria-pressed", "aria-checked"].map((name) => {
                  const value = element.getAttribute(name);
                  return value && value !== "false" ? `${name}="${value}"` : "";
                })
              )
              .find(Boolean);
            found.push({
              selector: selectorFor(item),
              label: labelFor(item),
              neighbours: group.length - 1,
              differences: [...new Set(differences)].slice(0, 3),
              ...(marked ? { state: marked } : {})
            });
          });
        }
      }
      return found.slice(0, 10);
    }
    // Images that may be words drawn as pixels: an image or image button shaped like a line of
    // text (at least 2.5 times as wide as it is tall, and 16 pixels tall), whose name is 2 to 8
    // words, as a heading, a button or a slogan is; a longer name describes a picture, such as a
    // screenshot. Not a logo, which WCAG exempts, nor a chart, diagram, map or photograph, whose
    // labels belong to the picture. Its pixels decide the rest.
    case "text-images":
      return [...document.querySelectorAll("img[alt], input[type=image][alt]")]
        .filter((image) => {
          const name = image.getAttribute("alt")!.trim();
          const words = name.split(/\s+/).filter(Boolean).length;
          const box = image.getBoundingClientRect();
          return (
            isVisible(image) &&
            !image.closest('[aria-hidden="true"]') &&
            words >= 2 &&
            words <= 8 &&
            !/\b(logo|logotype|wordmark)\b/i.test(name) &&
            !/^(a |an |the )?(photo|photograph|picture|image|illustration|chart|graph|diagram|map|screenshot|icon)\b/i.test(
              name
            ) &&
            box.height >= 16 &&
            box.width >= box.height * 2.5
          );
        })
        .slice(0, 10)
        .map((image) => ({
          selector: selectorFor(image),
          label: image.getAttribute("alt")!.trim()
        }));
    // Elements Tab reaches without a script, and a person could see and point at.
    case "focusable":
      return [
        ...document.querySelectorAll(
          'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]'
        )
      ].filter(
        (element) =>
          element instanceof HTMLElement &&
          element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !element.closest("[inert]") &&
          isVisible(element) &&
          onPage(element)
      ).length;
  }
}
