/**
 * A URL that is safe to keep as evidence: no user name or password, no fragment, and every query
 * value replaced, so tokens a page carries in its address are not written to disk (see
 * docs/privacy.md). The path stays. A value that is not a URL is redacted whole.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";

    for (const name of new Set(url.searchParams.keys())) {
      url.searchParams.set(name, "[REDACTED]");
    }

    return url.toString();
  } catch {
    return "[REDACTED]";
  }
}
