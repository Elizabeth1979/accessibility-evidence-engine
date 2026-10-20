import type { TargetDescriptor } from "./types";

/**
 * An interaction's target as the page finds it, the way a scenario's action finds it: by a
 * selector, with Playwright's `page.locator`, or by a role and an accessible name, with
 * Playwright's `getByRole`, which matches the whole name unless `exact` is false.
 */
export type RequestedTarget =
  { selector: string } | { role: string; name: string; exact?: boolean };

/**
 * The target an interaction names, as the page finds it: its selector when it has one, as the
 * action uses it, or else its role and name. Undefined for a role or a name alone.
 */
export function requestedTargetOf(
  target: TargetDescriptor | undefined
): RequestedTarget | undefined {
  if (target?.selector) return { selector: target.selector };
  if (!target?.role || !target.name) return undefined;
  return {
    role: target.role,
    name: target.name,
    ...(typeof target.exact === "boolean" ? { exact: target.exact } : {})
  };
}

/** The target in words: `selector main button`, or `button named "Save"`. */
export function describeRequestedTarget(target: RequestedTarget): string {
  if ("selector" in target) return `selector ${target.selector}`;
  return `${target.role} ${target.exact === false ? "whose name contains" : "named"} "${target.name}"`;
}

/** Whether two targets name the same elements: the same selector, or the same role and name. */
export function sameRequestedTarget(first: RequestedTarget, second: RequestedTarget): boolean {
  if ("selector" in first || "selector" in second) {
    return "selector" in first && "selector" in second && first.selector === second.selector;
  }
  return (
    first.role === second.role &&
    first.name === second.name &&
    (first.exact ?? true) === (second.exact ?? true)
  );
}
