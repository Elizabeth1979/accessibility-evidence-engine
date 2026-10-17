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
