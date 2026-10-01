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

/**
 * Resolves once an app has drawn the page: a page load returns before it has. That is once the
 * page's DOM has not changed for the capture policy's stabilizing pause, or after
 * QUIET_PAGE_LIMIT_MS at most. Style-only changes, as a script-driven animation makes on every
 * frame, do not count.
 */
export async function waitForQuietPage(page: QuietPageLike): Promise<void> {
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
      quietMs: resolvePolicyConfig().capture.stabilizeAfterInteractionMs,
      limitMs: QUIET_PAGE_LIMIT_MS
    }
  );
}
