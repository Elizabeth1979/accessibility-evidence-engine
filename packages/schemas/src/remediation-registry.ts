import registryJson from "../json/remediation-registry.json";

export interface RemediationRequirement {
  standard: string;
  requirementId: string;
  relationship: string;
  pattern?: string;
}

export interface RemediationEntry {
  id: string;
  patterns: string[];
  requirements: RemediationRequirement[];
}

/** The part of the registry that pattern lookups read. */
export interface RemediationRegistry {
  patternSource: { repository: string; commit: string; path: string };
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
  for (const entry of registry.entries) {
    const requirement = entry.requirements.find(
      (r) => r.standard === "axe-core" && r.requirementId === ruleId && r.pattern
    );
    if (requirement?.pattern) return patternLink(requirement.pattern, registry);
  }
  return undefined;
}
