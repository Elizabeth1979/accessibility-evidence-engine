/** The role of a piece of text the virtual reader stops on: Chromium's `StaticText`. */
export const TEXT_ROLE = "text";

/**
 * Chromium's own role names (CDP `internalRole`) that a screen reader announces as another role:
 * HTML-AAM maps `summary` to a button, and a text node is read as text.
 */
const SPOKEN_ROLES = new Map([
  ["DisclosureTriangle", "button"],
  ["StaticText", TEXT_ROLE]
]);

/**
 * The role the virtual reader reports for a node of Chromium's accessibility tree, so a reader
 * item and the tree node it was read from compare role for role.
 */
export function spokenRoleOf(browserRole: string): string {
  return SPOKEN_ROLES.get(browserRole) ?? browserRole;
}

/**
 * Chromium's role names (CDP `AXNode.role`) that differ from the WAI-ARIA 1.2 role they expose.
 * Chromium gives every other ARIA role its ARIA name; ARIA 1.2's `img` it calls `image`, the name
 * ARIA 1.3 adopts with `img` as its synonym.
 */
const ARIA_ROLES = new Map([["image", "img"]]);

/** The WAI-ARIA 1.2 role a browser role stands for, so ARIA's own role data applies to it. */
export function ariaRoleOf(browserRole: string): string {
  return ARIA_ROLES.get(browserRole) ?? browserRole;
}
