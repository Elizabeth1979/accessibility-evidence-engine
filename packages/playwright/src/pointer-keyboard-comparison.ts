import { isDeepStrictEqual } from "node:util";

export interface InteractionOutcomeComparison<T> {
  verdict: "pass" | "fail";
  pointerOutcome: T;
  keyboardOutcome: T;
  summary: string;
}

export interface ComparePointerAndKeyboardOptions<T> {
  reset(): Promise<void>;
  performPointerInteraction(): Promise<void>;
  performKeyboardInteraction(): Promise<void>;
  captureOutcome(): Promise<T>;
  equals?: (pointerOutcome: T, keyboardOutcome: T) => boolean;
}

/** Runs equivalent pointer and keyboard paths from the same reset state and compares outcomes. */
export async function comparePointerAndKeyboardOutcomes<T>(
  options: ComparePointerAndKeyboardOptions<T>
): Promise<InteractionOutcomeComparison<T>> {
  await options.reset();
  await options.performPointerInteraction();
  const pointerOutcome = await options.captureOutcome();
  await options.reset();
  await options.performKeyboardInteraction();
  const keyboardOutcome = await options.captureOutcome();
  const equivalent = (options.equals ?? isDeepStrictEqual)(pointerOutcome, keyboardOutcome);

  return {
    verdict: equivalent ? "pass" : "fail",
    pointerOutcome,
    keyboardOutcome,
    summary: equivalent
      ? "Pointer and keyboard interactions produced equivalent observable outcomes."
      : "Pointer and keyboard interactions produced different observable outcomes."
  };
}
