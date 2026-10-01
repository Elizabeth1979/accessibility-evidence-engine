import { expect, test } from "@playwright/test";

import { formatScore, scoreNames, wordMatch } from "./ai-score";
import { labFixtureModel } from "./test-lab-helpers";

test("a name scores by the words it shares with the right one, in any order", () => {
  expect(wordMatch("Archive Project Alpha", "archive project alpha")).toBe(1);
  expect(wordMatch("Help with projects", "Projects help")).toBe(1);
  // The free model's name for the archive button on 4.5's demo: two of three words, plus "View".
  expect(wordMatch("Archive Project Alpha", "View Project Archive")).toBeCloseTo(2 / 3);
  // An extra word costs as a missing one does.
  expect(wordMatch("Help with projects", "Get help")).toBe(0.5);
  expect(wordMatch("Archive Project Alpha", "Button")).toBe(0);
});

test("a model that answers with the fixed page's own names scores 100%", async ({
  browser
}, testInfo) => {
  const score = await scoreNames(browser, labFixtureModel().provider, testInfo);

  expect(score).toMatchObject({ providerId: "lab-fixture", score: 1, notes: [] });
  // The right names come from the fixed page, as the browser computes them.
  expect(score.answers).toEqual([
    {
      selector: "#archive-project",
      right: "Archive Project Alpha",
      answer: "Archive Project Alpha",
      match: 1
    },
    { selector: "#help-link", right: "Help with projects", answer: "Help with projects", match: 1 },
    {
      selector: "#usage-chart",
      right: "Reviews per day: 12 on Monday, rising to 30 on Friday.",
      answer: "Reviews per day: 12 on Monday, rising to 30 on Friday.",
      match: 1
    }
  ]);
  expect(formatScore(score).split("\n")[0]).toMatch(
    /^lab-fixture: 100% word match with the fixed page's names, 3 names, \d+\.\d s per question$/
  );
});
