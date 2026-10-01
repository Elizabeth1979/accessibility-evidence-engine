import { performance } from "node:perf_hooks";

import type { Browser, TestInfo } from "@playwright/test";

import {
  accessibleNameSpecialist,
  imagePurposeSpecialist,
  type ModelProvider,
  type ModelRequest
} from "@aee/ai-fixes";
import { describeSelectedElement, withCdpSession } from "@aee/playwright";

import { serveDirectory, startHtmlServer } from "./scenario-helpers";
import { contract, runOnLabPage } from "./test-lab-helpers";

/** The specialists whose answer is an element's name, which the fixed lab page holds. */
const NAMING_REQUESTS = new Set(
  [accessibleNameSpecialist, imagePurposeSpecialist].map(({ id }) => id.replaceAll("-", "_"))
);

export interface NameAnswer {
  selector: string;
  /** The name the fixed page gives the element, as the browser computes it. */
  right: string;
  /** The model's name; none when its answer was refused or never came. */
  answer?: string;
  /** How closely the answer's words match the right name's, from 0 to 1. */
  match: number;
}

export interface NameScore {
  providerId: string;
  /** The average match over every name the model was asked for. */
  score: number;
  answers: NameAnswer[];
  secondsPerQuestion: number;
  /** Why an answer is missing, as the report says. */
  notes: string[];
}

/** Words that carry no meaning in a name, so neither using nor leaving them out counts. */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "per",
  "the",
  "to",
  "with"
]);

function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((word) => !FILLER_WORDS.has(word))
      // "Projects" and "project" are the same word.
      .map((word) => (word.length > 3 ? word.replace(/s$/, "") : word))
  );
}

/**
 * How closely an answer's words match the right name's, in any order: 1 for the same words, 0
 * for none in common. A missing word and an extra word cost alike (the Dice coefficient), so a
 * name that says more than it should scores lower too.
 */
export function wordMatch(right: string, answer: string): number {
  const expected = words(right);
  const given = words(answer);
  const shared = [...expected].filter((word) => given.has(word)).length;
  return shared === 0 ? 0 : (2 * shared) / (expected.size + given.size);
}

/** The provider, recording what each question asked and how long it took to answer. */
function recorded(
  provider: ModelProvider,
  log: Array<{ request: ModelRequest; seconds: number }>
): ModelProvider {
  return {
    id: provider.id,
    async ask(request) {
      const started = performance.now();
      try {
        return await provider.ask(request);
      } finally {
        log.push({ request, seconds: (performance.now() - started) / 1000 });
      }
    }
  };
}

/** The names the fixed lab page gives these elements, as the browser's accessibility tree has them. */
async function fixedPageNames(browser: Browser, selectors: string[]): Promise<Map<string, string>> {
  const server = await startHtmlServer(serveDirectory("site"));
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/${contract.pages.fixed.url}`);
    return await withCdpSession(context, page, async (session) => {
      const names = new Map<string, string>();
      for (const selector of selectors) {
        names.set(selector, (await describeSelectedElement(session, selector))?.name ?? "");
      }
      return names;
    });
  } finally {
    await context.close();
    await server.close();
  }
}

/**
 * Runs `aee run` on the lab page with issues, as a user would, with this provider answering, and
 * scores each name it gave against the name the fixed page has for that element.
 */
export async function scoreNames(
  browser: Browser,
  provider: ModelProvider,
  testInfo: TestInfo
): Promise<NameScore> {
  const log: Array<{ request: ModelRequest; seconds: number }> = [];
  const { report } = await runOnLabPage(browser, contract.pages.issues, ["focus"], testInfo, {
    aiProvider: recorded(provider, log)
  });
  // Questions are asked in parallel, so they are listed by selector for a stable printout.
  const asked = [
    ...new Set(
      log
        .filter(({ request }) => NAMING_REQUESTS.has(request.name))
        .map(({ request }) => (request.input as { selector: string }).selector)
    )
  ].sort();
  const names = await fixedPageNames(browser, asked);
  const ai = report.synthesis.findings.map(({ remediation }) => remediation.ai);
  const answers = asked.map((selector): NameAnswer => {
    const right = names.get(selector) ?? "";
    const answer = ai
      .flatMap(({ suggestions = [] }) => suggestions)
      .find((suggestion) => suggestion.selector === selector)?.text;
    return { selector, right, answer, match: answer === undefined ? 0 : wordMatch(right, answer) };
  });
  return {
    providerId: provider.id,
    score: answers.reduce((total, { match }) => total + match, 0) / (answers.length || 1),
    answers,
    secondsPerQuestion: log.reduce((total, { seconds }) => total + seconds, 0) / (log.length || 1),
    notes: ai
      .flatMap(({ notes = [] }) => notes)
      .filter((note) => asked.some((s) => note.startsWith(s)))
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** The score as a person reads it: one line for the provider, then each name next to the right one. */
export function formatScore({ providerId, score, answers, secondsPerQuestion, notes }: NameScore) {
  return [
    `${providerId}: ${percent(score)} word match with the fixed page's names, ${answers.length} names, ${secondsPerQuestion.toFixed(1)} s per question`,
    ...answers.map(
      ({ selector, right, answer, match }) =>
        `  ${percent(match).padStart(4)}  ${selector}: ${answer === undefined ? "no answer" : JSON.stringify(answer)} (right: ${JSON.stringify(right)})`
    ),
    ...notes.map((note) => `  note: ${note}`)
  ].join("\n");
}
