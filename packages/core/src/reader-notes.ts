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
