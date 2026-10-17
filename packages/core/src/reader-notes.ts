/** A frame the virtual reader went into or came out of, as its transcript records it. */
export interface ReaderFrameCrossing {
  /** The frame element's accessible name. */
  name?: string;
  /** The `<iframe>` elements that hold the frame's document, outermost first. */
  framePath: string[];
}

/** The transcript line that says AEE's notes are not speech. */
export const READER_NOTES_LEGEND = 'Lines that start "AEE:" are AEE\'s notes, not speech.';

/**
 * AEE's notes for the frames a reader step came out of and went into, in that order. Guidepup's
 * reader says nothing at a frame's end, where NVDA says "out of frame"; the note shows where it is
 * without putting words in Guidepup's mouth.
 */
export function frameNotes(entry: {
  framesLeft?: ReaderFrameCrossing[];
  framesEntered?: ReaderFrameCrossing[];
}): string[] {
  const label = ({ name, framePath }: ReaderFrameCrossing) => name ?? framePath.at(-1) ?? "";
  return [
    ...(entry.framesLeft ?? []).map((frame) => `AEE: left frame ${label(frame)}`),
    ...(entry.framesEntered ?? []).map((frame) => `AEE: entered frame ${label(frame)}`)
  ];
}

/** The element a reader step found DOM focus on, as its transcript records it. */
export interface ReaderFocus {
  /** Its path in the document that holds it. */
  nodePath: string;
  /** The `<iframe>` elements it is inside, outermost first. Absent in the top document. */
  framePath?: string[];
}

/**
 * Where focus is, for a transcript line: the frame elements it is inside and its own path, joined
 * as an item's key joins them, or "none" when no element has focus.
 */
export function focusPlace(focus: ReaderFocus | undefined): string {
  return focus ? [...(focus.framePath ?? []), focus.nodePath].join(" >>> ") : "none";
}

/** The focus a transcript entry records, read from its JSON; undefined when it names none. */
export function readerFocusOf(value: unknown): ReaderFocus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { nodePath, framePath } = value as Record<string, unknown>;
  if (typeof nodePath !== "string" || !nodePath) return undefined;
  const frames = Array.isArray(framePath)
    ? framePath.filter((step): step is string => typeof step === "string")
    : [];
  return { nodePath, ...(frames.length ? { framePath: frames } : {}) };
}
