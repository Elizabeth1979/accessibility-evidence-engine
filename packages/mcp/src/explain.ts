import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { SWEEP_FINDING_CONCEPTS } from "@aee/playwright";
import { marked, type Tokens } from "marked";
import { Parser, type CST } from "yaml";
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
const PATTERN_FILE = ".instructions.md";
/** Where the index's links are relative to; only their file names are read. */
const INDEX_URL = "file:///patterns/INDEX.md";

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
    markdown: withoutFrontMatter(source)
  };
}

function patternIds(): string[] {
  return readdirSync(PATTERNS_DIR).flatMap((file) =>
    file.endsWith(PATTERN_FILE) ? [file.slice(0, -PATTERN_FILE.length)] : []
  );
}

/** The index's rows, "what you are building" → pattern, in the order the index lists them. */
function routes(): Array<{ words: Set<string>; pattern: string }> {
  return indexRoutes(readFileSync(path.join(PATTERNS_DIR, "INDEX.md"), "utf8"));
}

/**
 * The routes in an a11y-skills index, read as markdown: each table row that links to a pattern
 * file routes the words of the whole row to that pattern, and a row linking to two routes to both.
 */
export function indexRoutes(index: string): Array<{ words: Set<string>; pattern: string }> {
  const tables: Tokens.Table[] = [];
  marked.walkTokens(marked.lexer(withoutFrontMatter(index)), (token) => {
    // marked types an extension's token as any type name too, so "table" alone does not narrow.
    if (token.type === "table") tables.push(token as Tokens.Table);
  });
  return tables.flatMap(({ rows }) =>
    rows.flatMap((row) => {
      const text: string[] = [];
      const patterns: string[] = [];
      marked.walkTokens(
        row.flatMap(({ tokens }) => tokens),
        (token) => {
          if (token.type === "text" || token.type === "codespan") text.push(token.text);
          if (token.type === "link") {
            const file = path.posix.basename(new URL(token.href, INDEX_URL).pathname);
            if (file.endsWith(PATTERN_FILE)) patterns.push(file.slice(0, -PATTERN_FILE.length));
          }
        }
      );
      const rowWords = new Set(words(text.join(" ")));
      return patterns.map((pattern) => ({ words: rowWords, pattern }));
    })
  );
}

/**
 * A pattern's markdown without its front matter, which is for editors that load patterns by file
 * type, not for the reader. Front matter is a YAML document opened by the file's first line, so
 * YAML's own parser says where it ends: at the next document's `---` line.
 */
export function withoutFrontMatter(source: string): string {
  const [frontMatter, rest] = [...new Parser().parse(source)].filter(
    (token): token is CST.Document => token.type === "document"
  );
  if (frontMatter?.start[0]?.type !== "doc-start" || rest?.start[0]?.type !== "doc-start") {
    return source;
  }
  let end = rest.offset;
  for (const token of rest.start.slice(1)) {
    if (token.type === "newline") end = token.offset + token.source.length;
    else if (token.type !== "space") break;
  }
  return source.slice(end);
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
