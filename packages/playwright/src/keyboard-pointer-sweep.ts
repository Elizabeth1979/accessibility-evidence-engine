import { comparePointerAndKeyboardOutcomes } from "./pointer-keyboard-comparison";

/**
 * A sweep finds keyboard and pointer problems on a page without any authored steps:
 * - pointer-only: a mouse can click it, but the keyboard never reaches it;
 * - hover-only: content a hover reveals, which keyboard focus does not;
 * - activation-differs: pressing a control by keyboard does not do what clicking it does;
 * - focus-lost: after pressing a control by keyboard, focus is on nothing visible.
 */
export type SweepFindingKind = "pointer-only" | "hover-only" | "activation-differs" | "focus-lost";

/** The remediation-registry concept each kind of finding belongs to. */
export const SWEEP_FINDING_CONCEPTS = {
  "pointer-only": "keyboard-operation",
  "hover-only": "hover-focus-equivalence",
  "activation-differs": "keyboard-operation",
  "focus-lost": "focus-management"
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

export interface KeyboardPointerSweepResult {
  url: string;
  tabStops: string[];
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

export interface KeyboardPointerSweepPage {
  context(): { newCDPSession(page: unknown): Promise<KeyboardPointerSweepCdpSession> };
  goto(url: string): Promise<unknown>;
  evaluate<Result, Arg>(
    pageFunction: (arg: Arg) => Result | Promise<Result>,
    arg: Arg
  ): Promise<Result>;
  locator(selector: string): KeyboardPointerSweepLocator;
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
  | { mode: "active" }
  | { mode: "pointer-only"; tabStops: string[] }
  | { mode: "hover-rules"; styleSheets: string[] }
  | { mode: "visible"; selector: string }
  | { mode: "pressable"; tabStops: string[] }
  | { mode: "outcome"; selector: string }
  | { mode: "document" }
  | { mode: "focus-lost"; document: number };

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
  const probe = <T>(request: ProbeRequest) => page.evaluate(runSweepProbe, request) as Promise<T>;

  await page.goto(url);
  const tabStops = await collectTabStops(page, probe, options.maxTabStops ?? 200, onStep);
  const findings: SweepFinding[] = [];

  for (const target of await probe<ProbedElement[]>({ mode: "pointer-only", tabStops })) {
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
        if (await revealedOnFocus(page, probe, rule, revealed, tabStops)) continue;
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
    await page.goto(url);
    for (const control of await probe<PressableControl[]>({ mode: "pressable", tabStops })) {
      activated.push(control.selector);
      findings.push(
        ...(await timed(
          onStep,
          () => `Press ${describeElement(control)} with ${control.key}, then click it`,
          () => pressControl(page, probe, url, control)
        ))
      );
    }
  }

  return { url, tabStops, activated, findings };
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

async function collectTabStops(
  page: KeyboardPointerSweepPage,
  probe: <T>(request: ProbeRequest) => Promise<T>,
  maxTabStops: number,
  onStep: KeyboardPointerSweepOptions["onStep"]
): Promise<string[]> {
  const stops: string[] = [];
  const isNewStop = (active: ProbedElement | null): active is ProbedElement =>
    active !== null && !stops.includes(active.selector);
  for (let index = 0; index < maxTabStops; index += 1) {
    const active = await timed(
      onStep,
      (found) => (isNewStop(found) ? `Tab ${stops.length + 1}: ${describeElement(found)}` : ""),
      async () => {
        await page.keyboard.press("Tab");
        return probe<ProbedElement | null>({ mode: "active" });
      }
    );
    if (!isNewStop(active)) break;
    stops.push(active.selector);
  }
  return stops;
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
  url: string,
  control: PressableControl
): Promise<SweepFinding[]> {
  const findings: SweepFinding[] = [];
  const target = page.locator(control.selector);
  let loadedDocument = 0;
  let focusLost = false;
  const comparison = await comparePointerAndKeyboardOutcomes<ActivationOutcome>({
    reset: async () => {
      await page.goto(url);
      loadedDocument = await probe<number>({ mode: "document" });
    },
    performPointerInteraction: () => target.click(),
    performKeyboardInteraction: async () => {
      await target.press(control.key);
      focusLost = await probe<boolean>({ mode: "focus-lost", document: loadedDocument });
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
  if (focusLost) {
    findings.push(
      sweepFinding(
        "focus-lost",
        control,
        `After pressing ${control.key}, focus is left on nothing visible.`
      )
    );
  }
  return findings;
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
  const find = (selectors: string[]) =>
    selectors
      .map((selector) => document.querySelector(selector))
      .filter((element): element is Element => element !== null);

  switch (request.mode) {
    case "active": {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      return { selector: selectorFor(active), label: labelFor(active) };
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
                if (isVisible(element)) rules.push({ hover: selectorFor(element), revealed });
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
    case "outcome": {
      const target = document.querySelector(request.selector);
      const states: Record<string, string | null> = {};
      for (const name of ["aria-expanded", "aria-pressed", "aria-checked", "open"]) {
        states[name] = target?.getAttribute(name) ?? null;
      }
      return { url: location.href, text: document.body.innerText, states };
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
  }
}
