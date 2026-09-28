import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { SWEEP_FINDING_CONCEPTS } from "@aee/playwright";
import {
  conceptForAxeRule,
  patternLink,
  remediationEntry,
  remediationRegistry,
  type RemediationEntry
} from "@aee/schemas";

/** The a11y-skills patterns installed at the commit the registry, and so every report, links to. */
const PATTERNS_DIR = path.join(
  path.dirname(require.resolve("a11y-skills/package.json")),
  "patterns"
);

/** How a topic was read, in the order they are tried, and how the answer says so. */
const READ_AS = {
  "axe rule": "an axe rule",
  "AEE finding": "an AEE finding",
  "registry concept": "a remediation-registry concept",
  pattern: "an a11y-skills pattern name",
  "UI element": "a UI element, routed by the a11y-skills index"
} as const;
export type ExplainedAs = keyof typeof READ_AS | "no match";

export interface Explanation {
  topic: string;
  explainedAs: ExplainedAs;
  pattern: string;
  url: string;
  /** The WCAG criteria the registry ties the topic to, e.g. "WCAG 4.1.2 Name, Role, Value (A)". */
  requirements: string[];
  /** Other patterns the a11y-skills index routes the topic to just as well. */
  alsoConsider: string[];
  /** The pattern itself: its rules with good and bad examples, a complete example, WCAG references and a checklist. */
  markdown: string;
}

/**
 * The a11y-skills pattern for an axe rule id (`button-name`), an AEE finding id (`pointer-only`), a
 * registry concept (`accessible-name`), a pattern name (`dialog-modal`) or a UI element in words
 * (`icon button`). Rule and finding ids go through the remediation registry, the map every report
 * uses; words go through a11y-skills' own index. With no match it returns the general pattern, as
 * that index says to.
 */
export function explain(topic: string): Explanation {
  const key = topic.trim().toLowerCase();
  const axePattern = Object.hasOwn(remediationRegistry.axeRulePatterns, key)
    ? remediationRegistry.axeRulePatterns[key as keyof typeof remediationRegistry.axeRulePatterns]
    : undefined;
  if (axePattern) {
    return explanation(topic, "axe rule", axePattern, conceptForAxeRule(key));
  }
  if (Object.hasOwn(SWEEP_FINDING_CONCEPTS, key)) {
    const concept = remediationEntry(
      SWEEP_FINDING_CONCEPTS[key as keyof typeof SWEEP_FINDING_CONCEPTS]
    );
    return explanation(topic, "AEE finding", concept.patterns[0]!, concept);
  }
  const concept = remediationRegistry.entries.find(({ id }) => id === key);
  if (concept) return explanation(topic, "registry concept", concept.patterns[0]!, concept);
  if (patternIds().includes(key)) return explanation(topic, "pattern", key);
  const [best, ...alsoConsider] = routeByIndex(key);
  return best
    ? { ...explanation(topic, "UI element", best), alsoConsider }
    : explanation(topic, "no match", "accessibility");
}

/** The explanation as a coding agent reads it: where it came from, then the whole pattern. */
export function renderExplanation(explanation: Explanation): string {
  const lines = [
    `# a11y-skills pattern: ${explanation.pattern}`,
    "",
    explanation.explainedAs === "no match"
      ? `Nothing in the remediation registry or the a11y-skills index matched "${explanation.topic}", so this is the general pattern. Ask again with an axe rule id, an AEE finding id or the UI element you are building.`
      : `"${explanation.topic}" is ${READ_AS[explanation.explainedAs]}.`,
    ...(explanation.requirements.length
      ? [`Requirements: ${explanation.requirements.join("; ")}.`]
      : []),
    ...(explanation.alsoConsider.length
      ? [`Also consider: ${explanation.alsoConsider.join(", ")}.`]
      : []),
    `Source: ${explanation.url}`,
    "",
    explanation.markdown
  ];
  return lines.join("\n");
}

function explanation(
  topic: string,
  explainedAs: ExplainedAs,
  pattern: string,
  concept?: RemediationEntry
): Explanation {
  const source = readFileSync(path.join(PATTERNS_DIR, `${pattern}.instructions.md`), "utf8");
  return {
    topic,
    explainedAs,
    pattern,
    url: patternLink(pattern).url,
    requirements: (concept?.requirements ?? [])
      .filter(({ standard }) => standard === "WCAG")
      .map(
        ({ requirementId, title, level }) =>
          `WCAG ${requirementId} ${title}${level ? ` (${level})` : ""}`
      ),
    alsoConsider: [],
    // The front matter is for editors that load patterns by file type, not for the reader.
    markdown: source.replace(/^---\n[\s\S]*?\n---\n+/, "")
  };
}

function patternIds(): string[] {
  return readdirSync(PATTERNS_DIR).flatMap((file) =>
    file.endsWith(".instructions.md") ? [file.slice(0, -".instructions.md".length)] : []
  );
}

/** The index's rows, "what you are building" → pattern, in the order the index lists them. */
function routes(): Array<{ words: Set<string>; pattern: string }> {
  const index = readFileSync(path.join(PATTERNS_DIR, "INDEX.md"), "utf8");
  return [...index.matchAll(/^\|(.+)\|\s*\[([\w-]+)\]\([\w-]+\.instructions\.md\)\s*\|$/gm)].map(
    ([, text, pattern]) => ({ words: new Set(words(`${text} ${pattern}`)), pattern: pattern! })
  );
}

/** The patterns whose index rows share the most words with the topic, best first. */
function routeByIndex(topic: string): string[] {
  const asked = new Set(words(topic));
  const scored = routes().map(({ words: row, pattern }) => ({
    pattern,
    score: [...asked].filter((word) => row.has(word)).length
  }));
  const best = Math.max(0, ...scored.map(({ score }) => score));
  if (best === 0) return [];
  return [...new Set(scored.filter(({ score }) => score === best).map(({ pattern }) => pattern))];
}

const STOP_WORDS = new Set(
  "a an and any are as at be for from how i in including is it of on or that the this to vs what with".split(
    " "
  )
);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !STOP_WORDS.has(word))
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word
    );
}
