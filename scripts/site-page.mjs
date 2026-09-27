// Shared frame and text helpers for the site pages generated from repo data
// (the roadmap from the master plan, the test lab from its contract).

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

// Markdown-style inline text: `code`, **bold**, _emphasis_ and [links](https://…).
export function inline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,;:]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
