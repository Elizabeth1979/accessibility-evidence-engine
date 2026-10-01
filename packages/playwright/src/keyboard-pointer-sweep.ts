import { PNG } from "pngjs";

import { describeFocusedElement, withCdpSession, type CdpSession } from "./accessibility-tree";
import { findHeadingLookalikes } from "./heading-lookalikes";
import { comparePointerAndKeyboardOutcomes } from "./pointer-keyboard-comparison";
import { waitForQuietPage } from "./quiet-page";

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
 * - failure-not-announced: a request a press sends fails, and the page shows and says nothing.
 */
export type SweepFindingKind =
  | "pointer-only"
  | "hover-only"
  | "activation-differs"
  | "focus-lost"
  | "looks-like-heading"
  | "status-not-announced"
  | "failure-not-announced";

/** The remediation-registry concept each kind of finding belongs to. */
export const SWEEP_FINDING_CONCEPTS = {
  "pointer-only": "keyboard-operation",
  "hover-only": "hover-focus-equivalence",
  "activation-differs": "keyboard-operation",
  "focus-lost": "focus-management",
  "looks-like-heading": "heading-structure",
  "status-not-announced": "status-messages",
  "failure-not-announced": "status-messages"
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
  | { mode: "watch-changes"; selector: string }
  | { mode: "new-text"; selector: string }
  | { mode: "document" }
  | { mode: "focus-lost"; document: number }
  | { mode: "frame"; selector: string }
  | { mode: "blur" }
  | { mode: "start-at-top" }
  | { mode: "focusable" }
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

/**
 * The text a press showed: how many of its new elements a screen reader says, and those it does
 * not. Null when the press loaded a page or changed the control's own state, which a screen
 * reader says itself.
 */
type NewText = { said: number; unsaid: ProbedElement[] } | null;

interface ActivationOutcome {
  url: string;
  text: string;
  states: Record<string, string | null>;
}

/** Runs every keyboard and pointer check on one page, resetting it between checks. */
export async function sweepKeyboardAndPointer(
  options: KeyboardPointerSweepOptions
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
  const settle = () => onLoadedPage(() => waitForQuietPage(page));

  await loadAfresh(page, url);
  const findings: SweepFinding[] = (
    await withCdpSession(page.context(), page, findHeadingLookalikes)
  ).map(({ selector, text, fontSize, fontWeight, bodyFontSize, bodyFontWeight }) =>
    sweepFinding(
      "looks-like-heading",
      { selector, label: text },
      `Styled like a heading (${fontSize}px, weight ${fontWeight}, against body text at ${bodyFontSize}px, weight ${bodyFontWeight}), but the accessibility tree does not expose it as a heading.`
    )
  );
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

  for (const target of await pointerOnlyTargets(page, probe, url, stopSelectors, onStep)) {
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
    await loadAfresh(page, url);
    for (const control of await probe<PressableControl[]>({
      mode: "pressable",
      tabStops: stopSelectors
    })) {
      activated.push(control.selector);
      findings.push(
        ...(await timed(
          onStep,
          () => `Press ${describeElement(control)} with ${control.key}, then click it`,
          () => pressControl(page, probe, settle, url, control)
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
  url: string,
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
  await loadAfresh(page, url);
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
async function loadAfresh(page: KeyboardPointerSweepPage, url: string): Promise<void> {
  await page.goto(url);
  if (new URL(url).hash) await page.reload();
  await waitForQuietPage(page);
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
  url: string,
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
      await loadAfresh(page, url);
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
      pressed.newText = await probe<NewText>({ mode: "new-text", selector: control.selector });
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
  const { newText, failedRequests } = pressed;
  for (const message of newText?.unsaid ?? []) {
    findings.push(
      sweepFinding(
        "status-not-announced",
        message,
        `Pressing ${describeElement(control)} with ${control.key} shows this text, but a screen reader does not say it: it is in no live region that was on the page before, and focus did not move to it.`
      )
    );
  }
  // A message the page shows but does not say is reported above; here the page shows nothing.
  if (failedRequests.length > 0 && newText?.said === 0 && newText.unsaid.length === 0) {
    findings.push(
      sweepFinding(
        "failure-not-announced",
        control,
        `Pressing ${describeElement(control)} with ${control.key} sends a request that fails (${failedRequests.join("; ")}), and the page shows and says nothing about it.`
      )
    );
  }
  return findings;
}

/**
 * The requests that fail while `run` runs: an error status, or no response at all. Only requests a
 * script sends count, as a save or a load does; a missing image is no action's result. A request
 * the page cancelled, as a page load does to the requests still open, did not fail. Each is named
 * by its method and outcome, never its address, which can carry personal data.
 */
async function failedRequestsDuring(
  page: KeyboardPointerSweepPage,
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
  // A control's own state, which a screen reader says as it changes: expanded, pressed, checked.
  const statesOf = (element: Element | null): Record<string, string | null> =>
    Object.fromEntries(
      ["aria-expanded", "aria-pressed", "aria-checked", "open"].map((name) => [
        name,
        element?.getAttribute(name) ?? null
      ])
    );
  // Text compared across a press, as the page shows it or as its nodes hold it, which differ in
  // spacing and in case a style transforms.
  const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  // What a press changed, recorded from just before it; "new-text" reads and ends it.
  const watchKey = Symbol.for("aee.sweep.watch-changes");
  interface ChangeWatch {
    url: string;
    text: string;
    states: Record<string, string | null>;
    liveRegions: Element[];
    changed: Set<Element>;
    observer: MutationObserver;
  }
  const store = globalThis as unknown as Record<symbol, ChangeWatch | undefined>;

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
          return element.matches(
            "button, summary, [role=button], [role=switch], [role=checkbox], input[type=checkbox], input[type=radio]"
          );
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
      store[watchKey] = {
        url: location.href,
        text: normalized(document.body.innerText),
        states: statesOf(document.querySelector(request.selector)),
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
      return null;
    }
    // The text a press showed (see NewText). Text is said when it is in a live region that was
    // there before (or an alert, which is said as it is added) or focus moved to it. Controls are
    // left out, as their text is their name, and so are dialogs, whose focus is a check of its own.
    case "new-text": {
      const watch = store[watchKey];
      delete store[watchKey];
      // No watch: the press loaded another document.
      if (!watch) return null;
      watch.observer.disconnect();
      const control = document.querySelector(request.selector);
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
      const margin = 12;
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
