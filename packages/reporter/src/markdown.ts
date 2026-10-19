/**
 * Text that can come from a tested page, such as a button's name, written into Markdown so that
 * it shows as itself: never as emphasis, a link, an image, HTML, a heading or a table column.
 */

/**
 * Every ASCII punctuation character. CommonMark lets a backslash escape each one, and an escaped
 * character is shown as itself wherever it is (spec 0.31.2, section 2.4, "Backslash escapes").
 * Escaping all of them, not a chosen few, means no character can start Markdown, HTML, an entity
 * or a GFM autolink, in any position in a line.
 */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;

/**
 * Page text inside Markdown, on one line, shown as itself, with no mentions or issue links. A
 * pipe is escaped too, so it is also safe in a GFM table cell.
 */
export function markdownText(value: string): string {
  return withoutReferences(oneLine(value)).replace(ASCII_PUNCTUATION, "\\$&");
}

/**
 * Page text shown literally as code: in a code span GitHub renders no Markdown or HTML and makes
 * no mentions or issue links. The fence is longer than any run of backticks in the text. In a
 * GFM table cell, escape its pipes as well (`markdownTableCode`).
 */
export function markdownCode(value: string): string {
  const text = oneLine(value);
  if (!text) return "(no text)";
  const fence = "`".repeat(
    Math.max(0, ...(text.match(/`+/g) ?? []).map(({ length }) => length)) + 1
  );
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * `markdownCode` in a GFM table cell. A table splits its row at every pipe, even in a code span,
 * unless the pipe is escaped; the table removes that backslash before the code span is read.
 */
export function markdownTableCode(value: string): string {
  return markdownCode(value).replaceAll("|", "\\|");
}

/**
 * A zero-width space stops GitHub turning page text into a mention (@name, not inside a word, as
 * in an email address) or an issue link (#123, also owner/repo#123); a colour such as #3f4c48 is
 * left alone, since GitHub links only digits.
 */
export function withoutReferences(value: string): string {
  return value.replace(/(?<!\w)@(?=[a-z\d])/gi, "@​").replace(/#(?=\d+\b)/g, "#​");
}

/** Markdown ends a table row or a heading at a line break, so page text is kept on one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
