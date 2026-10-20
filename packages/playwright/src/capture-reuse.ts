import type { CdpContext } from "./accessibility-tree";

/**
 * A page a lane's captures can be reused on: one AEE can run code in and open a DevTools session
 * on, as a Playwright page can.
 */
export interface CaptureReusePage {
  evaluate<Arg>(pageFunction: (arg: Arg) => unknown, arg: Arg): Promise<unknown>;
  context(): CdpContext;
}

/**
 * The captures one lane has taken of its page. A lane whose steps only read the page, as the
 * virtual reader's do, takes the costly captures (axe, the screenshots, the element map) once and
 * gives each later step the same result, for as long as it can prove the page has not changed
 * since: the result is then what a fresh capture would give, and so are the files, findings and
 * verdicts made from it, except that axe's result keeps the time axe ran. When the page has
 * changed, or the proof cannot be made, the step captures afresh.
 */
export interface LaneCaptures {
  /** The captures for one step on the page. */
  forStep(page: CaptureReusePage): StepCaptures;
  /** Stops watching the page, which stays open for whoever owns it. */
  stop(): Promise<void>;
}

export interface StepCaptures {
  /**
   * The capture named `key`, taken by `capture` unless the lane holds one taken since the page
   * last changed. `key` names the capture and its options; each call gets its own copy.
   */
  take<Value>(key: string, capture: () => Promise<Value>): Promise<Value>;
  /** Called once the step's captures are all taken: a step that took them afresh starts the watch. */
  finish(): Promise<void>;
}

/**
 * The proof, for a capture taken afresh: the page is read as the capture starts and again once it
 * ends, DOM included, and only a page that reads the same both times is watched from then on (a
 * capture changes the page for a moment, as the contrast measurement hides texts, and puts it back,
 * so no watch can run while it does). The watch is a MutationObserver on the document and each
 * open shadow root, which sees any change to the DOM even one undone before the next step, and a
 * PerformanceObserver that sees anything load. A later step reuses the captures only when neither
 * saw anything and the page reads as it did, from scroll positions and field values to focus,
 * open popovers, the selection, stylesheets, fonts, images and animations.
 */
export function createLaneCaptures(): LaneCaptures {
  let captures = new Map<string, unknown>();
  // The page watched since the captures were taken; none while there are no captures to reuse.
  let watched: CaptureReusePage | undefined;

  return {
    forStep(page) {
      let decision: Promise<"reuse" | { pageBefore: string | null }> | undefined;
      const decide = () =>
        (decision ??= (async () => {
          if (watched === page && (await unchangedSinceWatched(page))) return "reuse";
          watched = undefined;
          captures = new Map();
          return { pageBefore: (await readPage(page, "read")) as string | null };
        })());

      return {
        async take<Value>(key: string, capture: () => Promise<Value>): Promise<Value> {
          await decide();
          if (!captures.has(key)) captures.set(key, structuredClone(await capture()));
          return structuredClone(captures.get(key)) as Value;
        },
        async finish() {
          if (!decision) return;
          const decided = await decision;
          if (decided === "reuse") return;
          const pageAfter = (await readPage(page, "watch")) as string | null;
          if (decided.pageBefore !== null && pageAfter === decided.pageBefore) {
            watched = page;
          } else {
            captures = new Map();
          }
        }
      };
    },
    async stop() {
      await watched?.evaluate(watchPage, { key: WATCH_KEY, mode: "stop" });
      watched = undefined;
    }
  };
}

/** Where the watch is kept in the page: a registered symbol, which no page script names by chance. */
const WATCH_KEY = "aee.captureWatch";

async function readPage(page: CaptureReusePage, mode: "read" | "watch"): Promise<unknown> {
  return page.evaluate(watchPage, { key: WATCH_KEY, mode });
}

/**
 * Whether the page is as it was when the watch started. A closed shadow root is out of reach of
 * the page's own code, so its content cannot be watched; the browser itself says whether there is
 * one, and a page with one is always captured afresh.
 */
async function unchangedSinceWatched(page: CaptureReusePage): Promise<boolean> {
  if (!(await page.evaluate(watchPage, { key: WATCH_KEY, mode: "check" }))) return false;
  const session = await page.context().newCDPSession(page);
  try {
    const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as {
      root: DomNode;
    };
    return !hasClosedShadowRoot(root);
  } finally {
    await session.detach?.();
  }
}

interface DomNode {
  shadowRootType?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  templateContent?: DomNode;
}

function hasClosedShadowRoot(node: DomNode): boolean {
  if (node.shadowRootType === "closed") return true;
  return [
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
    ...(node.contentDocument ? [node.contentDocument] : [])
  ].some(hasClosedShadowRoot);
}

/**
 * Runs in the page. `read` reads the page: everything a capture of it depends on, DOM included,
 * or null when it holds something that can change its look with no trace in the DOM (a frame, a
 * canvas, a video or a running animation). `watch` does the same read and starts watching the
 * page; `check` says whether the watch saw nothing and the page reads as it did when it started;
 * `stop` ends the watch.
 */
function watchPage({
  key,
  mode
}: {
  key: string;
  mode: "read" | "watch" | "check" | "stop";
}): string | boolean | null {
  interface Watch {
    changed: boolean;
    observers: Array<MutationObserver | PerformanceObserver>;
    state: string;
  }
  const store = window as unknown as Record<symbol, Watch | undefined>;
  const symbol = Symbol.for(key);
  const previous = store[symbol];
  if (mode === "stop" || mode === "watch") {
    previous?.observers.forEach((observer) => observer.disconnect());
    delete store[symbol];
    if (mode === "stop") return null;
  }

  // Every element, through open shadow roots, and the roots themselves.
  const roots: Array<Document | ShadowRoot> = [document];
  const elements: Element[] = [];
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of roots[index]!.querySelectorAll("*")) {
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const animations = [...new Set(roots.flatMap((root) => root.getAnimations()))];
  const unwatchable =
    window.frames.length > 0 ||
    elements.some(({ localName }) => localName === "canvas" || localName === "video") ||
    animations.some(({ playState }) => playState === "running");
  if (unwatchable) return mode === "check" ? false : null;

  const indexOf = (element: Element | null | undefined) =>
    element ? elements.indexOf(element) : -1;
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  const selection = getSelection();
  const styleSheets = roots.flatMap((root) => [...root.styleSheets, ...root.adoptedStyleSheets]);
  const state = JSON.stringify({
    viewport: [innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY],
    focused: indexOf(focused),
    fullscreen: indexOf(document.fullscreenElement),
    shown: elements.flatMap((element, index) =>
      element.matches(":popover-open, :modal") ? [index] : []
    ),
    scrolled: elements.flatMap((element, index) =>
      element.scrollTop || element.scrollLeft
        ? [[index, element.scrollTop, element.scrollLeft]]
        : []
    ),
    fields: elements.flatMap((element, index): unknown[] =>
      element instanceof HTMLInputElement
        ? [[index, element.value, element.checked, element.indeterminate]]
        : element instanceof HTMLTextAreaElement
          ? [[index, element.value]]
          : element instanceof HTMLSelectElement
            ? [[index, [...element.options].map(({ selected }) => selected)]]
            : []
    ),
    images: elements.flatMap((element, index) =>
      element instanceof HTMLImageElement
        ? [[index, element.complete, element.naturalWidth, element.currentSrc]]
        : []
    ),
    animations: animations.map((animation) => [
      animation.playState,
      animation.currentTime,
      indexOf((animation.effect as KeyframeEffect | null)?.target)
    ]),
    selection: selection && [
      selection.type,
      selection.rangeCount,
      selection.anchorOffset,
      selection.focusOffset,
      selection.toString()
    ],
    fonts: [document.fonts.status, document.fonts.size],
    // A stylesheet from another origin cannot be read, and the page cannot change it either.
    styleSheets: styleSheets.map((sheet) => {
      try {
        return [sheet.disabled, [...sheet.cssRules].map(({ cssText }) => cssText)];
      } catch {
        return [sheet.disabled, sheet.href];
      }
    })
  });

  if (mode === "check") {
    if (!previous) return false;
    const changed =
      previous.changed || previous.observers.some((observer) => observer.takeRecords().length > 0);
    return !changed && state === previous.state;
  }
  const dom = roots.map((root) =>
    root instanceof Document ? root.documentElement.outerHTML : root.innerHTML
  );
  if (mode === "watch") {
    const watch: Watch = { changed: false, observers: [], state };
    const changed = () => {
      watch.changed = true;
    };
    for (const root of roots) {
      const observer = new MutationObserver(changed);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
      watch.observers.push(observer);
    }
    const loads = new PerformanceObserver(changed);
    loads.observe({ type: "resource" });
    watch.observers.push(loads);
    store[symbol] = watch;
  }
  return JSON.stringify([state, dom]);
}
