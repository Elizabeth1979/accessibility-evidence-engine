import { resolvePolicyConfig } from "@aee/core";

/** The longest the wait lasts for a page that keeps changing, such as one with a ticking clock. */
const QUIET_PAGE_LIMIT_MS = 3_000;

/** A page that can run a function, as a Playwright page can. */
export interface QuietPageLike {
  evaluate?<TArgument>(
    pageFunction: (argument: TArgument) => unknown,
    argument?: TArgument
  ): Promise<unknown>;
}

/** A page that reports the requests it sends and how each ends, as a Playwright page does. */
export interface RequestReportingPage {
  on(event: "request", listener: (request: object) => void): unknown;
  on(event: "requestfinished", listener: (request: object) => void): unknown;
  on(event: "requestfailed", listener: (request: object) => void): unknown;
  off(event: "request", listener: (request: object) => void): unknown;
  off(event: "requestfinished", listener: (request: object) => void): unknown;
  off(event: "requestfailed", listener: (request: object) => void): unknown;
}

/** Whether a page reports its requests, as a Playwright page does and a stand-in may not. */
export function reportsRequests(page: object): page is RequestReportingPage {
  const { on, off } = page as Partial<RequestReportingPage>;
  return typeof on === "function" && typeof off === "function";
}

/** The requests a page has open, counted from when tracking starts. */
export interface OpenRequests {
  readonly count: number;
  /** Resolves once no request is open: at once when none is. */
  settled(): Promise<void>;
  stop(): void;
}

/**
 * Starts counting the requests a page has open. Start it before the page loads, so the requests
 * its load sends are counted too.
 */
export function trackOpenRequests(page: RequestReportingPage): OpenRequests {
  const open = new Set<object>();
  let waiting: Array<() => void> = [];
  const opened = (request: object) => {
    open.add(request);
  };
  const closed = (request: object) => {
    open.delete(request);
    if (open.size > 0) return;
    for (const resolve of waiting) resolve();
    waiting = [];
  };
  page.on("request", opened);
  page.on("requestfinished", closed);
  page.on("requestfailed", closed);
  return {
    get count() {
      return open.size;
    },
    settled: () =>
      open.size === 0 ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve)),
    stop() {
      page.off("request", opened);
      page.off("requestfinished", closed);
      page.off("requestfailed", closed);
    }
  };
}

/**
 * Resolves once an app has drawn the page: a page load returns before it has. An app often draws
 * once its data arrives, so the wait first lets the page's open requests finish, then waits until
 * its DOM has not changed for the capture policy's stabilizing pause, and does both again if
 * drawing sent new requests. It lasts QUIET_PAGE_LIMIT_MS at most. Style-only changes, as a
 * script-driven animation makes on every frame, do not count.
 */
export async function waitForQuietPage(
  page: QuietPageLike,
  openRequests?: OpenRequests
): Promise<void> {
  const deadline = Date.now() + QUIET_PAGE_LIMIT_MS;
  do {
    if (openRequests) await before(deadline, openRequests.settled());
    await waitForQuietDom(page, Math.max(0, deadline - Date.now()));
  } while (openRequests?.count && Date.now() < deadline);
}

/** Resolves with the promise, or at the deadline if it has not settled by then. */
async function before(deadline: number, promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    })
  ]);
  clearTimeout(timer);
}

async function waitForQuietDom(page: QuietPageLike, limitMs: number): Promise<void> {
  await page.evaluate?.(
    ({ quietMs, limitMs }: { quietMs: number; limitMs: number }) =>
      new Promise<void>((resolve) => {
        const done = () => {
          observer.disconnect();
          clearTimeout(quiet);
          clearTimeout(limit);
          resolve();
        };
        let quiet = setTimeout(done, quietMs);
        const limit = setTimeout(done, limitMs);
        const observer = new MutationObserver((mutations) => {
          if (mutations.every(({ attributeName }) => attributeName === "style")) return;
          clearTimeout(quiet);
          quiet = setTimeout(done, quietMs);
        });
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        });
      }),
    {
      quietMs: Math.min(resolvePolicyConfig().capture.stabilizeAfterInteractionMs, limitMs),
      limitMs
    }
  );
}
