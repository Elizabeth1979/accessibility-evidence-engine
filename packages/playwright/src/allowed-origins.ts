import { redactUrl } from "@aee/core";

/** A lane reached a page outside its allowed origins, so it stopped: the lane is "blocked". */
export class BlockedOriginError extends Error {}

export function normalizeAllowedOrigins(
  origins: string[],
  laneName = "virtual screen-reader lane"
): string[] {
  if (origins.length === 0) {
    throw new Error(`A ${laneName} requires at least one allowed origin.`);
  }

  return [...new Set(origins.map((origin) => new URL(origin).origin))].sort();
}

export function assertAllowedOrigin(
  value: string,
  allowedOrigins: string[],
  laneLabel = "Virtual screen-reader lane"
): void {
  const origin = new URL(value).origin;

  if (!allowedOrigins.includes(origin)) {
    throw new BlockedOriginError(
      `${laneLabel} blocked origin ${origin} at ${redactUrl(value)}; allowed origins: ${allowedOrigins.join(", ")}.`
    );
  }
}
