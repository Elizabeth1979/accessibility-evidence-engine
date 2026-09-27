import registryJson from "../json/remediation-registry.json";

export interface RemediationRequirement {
  standard: string;
  requirementId: string;
  relationship: string;
}

export interface RemediationEntry {
  id: string;
  title: string;
  patterns: string[];
  requirements: RemediationRequirement[];
  ai: { allowed: boolean; specialistId?: string; purpose: string };
  verification: string[];
}

/** The part of the registry that pattern lookups read. */
export interface RemediationRegistry {
  patternSource: { repository: string; commit: string; path: string };
  /** axe rule id → the a11y-skills pattern that explains its fix. */
  axeRulePatterns: Record<string, string>;
  entries: RemediationEntry[];
}

export interface PatternLink {
  id: string;
  url: string;
}

/** The canonical concept → WCAG → axe → pattern map, validated against its schema in tests. */
export const remediationRegistry = registryJson;

/** Links a pattern id to its a11y-skills file at the commit the registry pins. */
export function patternLink(
  id: string,
  registry: RemediationRegistry = remediationRegistry
): PatternLink {
  const { repository, commit, path } = registry.patternSource;
  return { id, url: `${repository}/blob/${commit}/${path.replace("{pattern}", id)}` };
}

/** The pattern that explains an axe rule, when the registry maps that rule. */
export function patternForAxeRule(
  ruleId: string,
  registry: RemediationRegistry = remediationRegistry
): PatternLink | undefined {
  const id = Object.hasOwn(registry.axeRulePatterns, ruleId)
    ? registry.axeRulePatterns[ruleId]
    : undefined;
  return id === undefined ? undefined : patternLink(id, registry);
}

/** The registry entry for a concept; an id the registry does not define is an error. */
export function remediationEntry(
  id: string,
  registry: RemediationRegistry = remediationRegistry
): RemediationEntry {
  const entry = registry.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`The remediation registry has no concept "${id}".`);
  return entry;
}

/** The concept whose detection includes an axe rule, when the registry maps that rule. */
export function conceptForAxeRule(
  ruleId: string,
  registry: RemediationRegistry = remediationRegistry
): RemediationEntry | undefined {
  return registry.entries.find(({ requirements }) =>
    requirements.some(
      ({ standard, requirementId }) => standard === "axe-core" && requirementId === ruleId
    )
  );
}
