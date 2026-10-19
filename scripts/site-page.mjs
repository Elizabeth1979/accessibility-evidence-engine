// Shared frame and text helpers for the site pages generated from repo data
// (the roadmap from the master plan, the test lab from its contract, and the
// homepage sections generated from the registry and the feature list).
import { Marked } from "marked";

export function renderSitePage({ title, stylesheets, mainClass, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · AEE</title>
    <link rel="stylesheet" href="styles.css" />
${stylesheets.map((href) => `    <link rel="stylesheet" href="${href}" />`).join("\n")}
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header"><a href="index.html">Accessibility Evidence Engine</a></header>
    <main id="main" class="${mainClass}">
${body}
    </main>
  </body>
</html>
`;
}

// Inline markdown (`code`, **bold**, _emphasis_, [links](https://…)) rendered by marked. Marked
// "does not sanitize the output HTML", so raw HTML in the text is escaped and shows as written.
const markdown = new Marked({
  renderer: {
    html: ({ text }) => escapeHtml(text)
  }
});

// `base` is the address of the file the text comes from, so its relative links keep pointing
// where they point there.
export function inline(value, base) {
  return markdown.parseInline(String(value), {
    walkTokens: base
      ? (token) => {
          if (token.type === "link") token.href = new URL(token.href, base).href;
        }
      : null
  });
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Swaps the generated part of a hand-written page: everything between
// <!-- name:start --> and <!-- name:end -->. Prettier formats the result afterwards.
export function replaceBetweenMarkers(source, name, replacement) {
  const startMarker = `<!-- ${name}:start -->`;
  const endMarker = `<!-- ${name}:end -->`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not find the ${name} markers.`);
  }
  return `${source.slice(0, start + startMarker.length)}\n${replacement}\n${source.slice(end)}`;
}
