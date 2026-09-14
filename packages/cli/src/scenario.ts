import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { assertValidSchema, CURRENT_SCHEMA_VERSION } from "@aee/schemas";
import type { VirtualScreenReaderCommand } from "@aee/playwright";
import { parseDocument } from "yaml";

export type ScenarioProfile = "core" | "at-fidelity";
export type ImplementationStatus = "available" | "partial" | "planned";

export interface AeeScenario {
  $schema?: string;
  schemaVersion: string;
  id: string;
  target: {
    url: string;
    allowedOrigins?: string[];
  };
  standard: {
    name: "WCAG";
    version: "2.0" | "2.1" | "2.2";
    levels: Array<"A" | "AA" | "AAA">;
  };
  profile: ScenarioProfile;
  goal: string;
  journeys: ScenarioJourney[];
  privacy?: ScenarioPrivacy;
  approval: {
    required: true;
    approvedPlanDigest?: string;
  };
}

export interface ScenarioJourney {
  id: string;
  name: string;
  goal: string;
  startPath?: string;
  allowedActions: string[];
  forbiddenActions: string[];
  virtualScreenReaderCommands?: VirtualScreenReaderCommand[];
}

export interface ScenarioPrivacy {
  storage: "local" | "custom";
  remoteUpload: "forbidden" | "explicit-only";
  sharingReviewRequired: true;
}

export interface ScenarioCapability {
  id: string;
  label: string;
  kind: "active-lane" | "passive-observer" | "reporter";
  requirement: "required" | "optional";
  implementationStatus: ImplementationStatus;
}

export interface ScenarioPlan {
  schemaVersion: string;
  scenarioId: string;
  scenarioDigest: string;
  planDigest: string;
  target: string;
  standard: string;
  profile: ScenarioProfile;
  goal: string;
  approval: {
    required: true;
    status: "pending" | "approved" | "digest-mismatch";
  };
  readiness: {
    status: "ready" | "blocked";
    summary: string;
    blockingCapabilityIds: string[];
  };
  requiredCapabilities: ScenarioCapability[];
  journeys: Array<{
    id: string;
    name: string;
    goal: string;
    startUrl: string;
    steps: Array<{
      id: string;
      label: string;
      source: "profile" | "user-permission" | "user-command";
    }>;
  }>;
  safety: {
    allowedOrigins: string[];
    allowedActions: string[];
    forbiddenActions: string[];
    conflicts: [];
  };
  privacy: ScenarioPrivacy;
}

const CORE_CAPABILITIES: ScenarioCapability[] = [
  capability("keyboard-lane", "Keyboard input lane", "active-lane", "partial"),
  capability("pointer-hover-lane", "Pointer and hover input lane", "active-lane", "partial"),
  capability(
    "virtual-screen-reader-lane",
    "Portable virtual screen-reader lane",
    "active-lane",
    "available"
  ),
  capability("viewport-screenshot", "Viewport screenshot", "passive-observer", "available"),
  capability("full-page-screenshot", "Full-page screenshot", "passive-observer", "available"),
  capability("dom-snapshot", "Full DOM snapshot", "passive-observer", "available"),
  capability(
    "accessibility-tree",
    "Full accessibility-tree snapshot",
    "passive-observer",
    "available"
  ),
  capability("deep-focus-state", "Deep focus state", "passive-observer", "partial"),
  capability("axe-results", "Pinned axe results", "passive-observer", "available"),
  capability("interaction-trace", "Complete interaction trace", "passive-observer", "partial"),
  capability(
    "screen-reader-transcript",
    "Virtual screen-reader transcript",
    "passive-observer",
    "available"
  ),
  capability("interaction-video", "Interaction video and sidecar", "passive-observer", "planned"),
  capability("evidence-manifest", "Checksummed evidence manifest", "reporter", "planned"),
  capability(
    "integrated-report",
    "Integrated HTML, JSON, and Markdown report",
    "reporter",
    "partial"
  )
];

const AT_FIDELITY_CAPABILITY: ScenarioCapability = capability(
  "real-at-lane",
  "VoiceOver or NVDA fidelity lane",
  "active-lane",
  "planned"
);

const PROFILE_STEPS: ScenarioPlan["journeys"][number]["steps"] = [
  step("validate-scope", "Validate the target origin, journey scope, and action permissions."),
  step(
    "capture-initial-state",
    "Capture synchronized viewport, full-page, DOM, accessibility-tree, and focus evidence."
  ),
  step("run-axe", "Run the pinned WCAG rule selection and preserve complete axe output."),
  step(
    "inventory-interactions",
    "Inventory semantic and visually inferred interactive candidates without activating them."
  ),
  step(
    "exercise-keyboard",
    "Traverse with the keyboard and use role-appropriate activation keys only on user-allowed targets in an isolated lane."
  ),
  step(
    "exercise-virtual-reader",
    "Navigate headings, landmarks, controls, and content with the virtual screen reader."
  ),
  step(
    "recapture-every-action",
    "After every meaningful action, recapture synchronized evidence and record focus separately from announcements."
  ),
  step(
    "correlate-evidence",
    "Correlate raw evidence without converting missing, blocked, or contradictory results into passes."
  ),
  step(
    "publish-report",
    "Publish one integrated report with raw artifact links and an explicit completeness result."
  )
];

const ACTION_STEP_LABELS: Record<string, string> = {
  navigate: "Follow only navigation that stays within the approved target origins.",
  "open-menus": "Open and close menus with pointer and role-appropriate keyboard controls.",
  hover: "Compare pointer hover with keyboard focus and activation outcomes.",
  focus: "Inspect visible focus and deep focus state throughout the journey.",
  "activate-public-links":
    "Activate public informational links without submitting data or starting restricted workflows."
};

export async function loadScenario(scenarioPath: string): Promise<AeeScenario> {
  const raw = await readFile(scenarioPath, "utf8");
  const document = parseDocument(raw, {
    strict: true,
    uniqueKeys: true
  });

  if (document.errors.length > 0) {
    throw new Error(
      `Invalid YAML in AEE scenario at ${scenarioPath}: ${document.errors
        .map((error) => error.message)
        .join("; ")}`
    );
  }

  const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
  assertValidSchema("scenario", parsed, `AEE scenario at ${scenarioPath}`);
  validateScenarioSemantics(parsed as AeeScenario);
  return parsed as AeeScenario;
}

export function compileScenarioPlan(scenario: AeeScenario): ScenarioPlan {
  validateScenarioSemantics(scenario);

  const scenarioDigest = digest({
    ...scenario,
    approval: { required: true }
  });
  const requiredCapabilities = [
    ...CORE_CAPABILITIES.map((entry) => ({ ...entry })),
    ...(scenario.profile === "at-fidelity" ? [{ ...AT_FIDELITY_CAPABILITY }] : [])
  ];
  const blockingCapabilityIds = requiredCapabilities
    .filter(
      ({ requirement, implementationStatus }) =>
        requirement === "required" && implementationStatus !== "available"
    )
    .map(({ id }) => id);
  const privacy: ScenarioPrivacy = scenario.privacy ?? {
    storage: "local",
    remoteUpload: "forbidden",
    sharingReviewRequired: true
  };
  const journeys = scenario.journeys.map((journey) => ({
    id: journey.id,
    name: journey.name,
    goal: journey.goal,
    startUrl: new URL(journey.startPath ?? "/", scenario.target.url).href,
    steps: [
      ...PROFILE_STEPS.map((entry) => ({ ...entry })),
      ...journey.allowedActions.map((action) => ({
        id: `permission-${action}`,
        label:
          ACTION_STEP_LABELS[action] ??
          `Exercise the user-authorized action “${humanize(action)}” within the declared safety boundary.`,
        source: "user-permission" as const
      })),
      ...(journey.virtualScreenReaderCommands ?? []).map((command, index) => ({
        id: `reader-command-${index + 1}-${command}`,
        label: `Run the user-selected virtual screen-reader command “${command}” in the isolated reader lane.`,
        source: "user-command" as const
      }))
    ]
  }));
  const allowedActions = uniqueSorted(
    scenario.journeys.flatMap(({ allowedActions }) => allowedActions)
  );
  const forbiddenActions = uniqueSorted(
    scenario.journeys.flatMap(({ forbiddenActions }) => forbiddenActions)
  );
  const allowedOrigins = uniqueSorted(
    (scenario.target.allowedOrigins ?? [scenario.target.url]).map((url) => new URL(url).origin)
  );
  const planPayload = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    scenarioId: scenario.id,
    scenarioDigest,
    target: scenario.target.url,
    standard: `${scenario.standard.name} ${scenario.standard.version} ${scenario.standard.levels.join("/")}`,
    profile: scenario.profile,
    goal: scenario.goal,
    readiness: {
      status: blockingCapabilityIds.length === 0 ? ("ready" as const) : ("blocked" as const),
      summary:
        blockingCapabilityIds.length === 0
          ? "Every capability required by this profile is implemented."
          : `${blockingCapabilityIds.length} required capabilities are not fully implemented.`,
      blockingCapabilityIds
    },
    requiredCapabilities,
    journeys,
    safety: {
      allowedOrigins,
      allowedActions,
      forbiddenActions,
      conflicts: [] as []
    },
    privacy
  };
  const planDigest = digest(planPayload);
  const approvedDigest = scenario.approval.approvedPlanDigest;
  const approvalStatus = approvedDigest
    ? approvedDigest === planDigest
      ? "approved"
      : "digest-mismatch"
    : "pending";
  const plan: ScenarioPlan = {
    ...planPayload,
    planDigest,
    approval: {
      required: true,
      status: approvalStatus
    }
  };

  assertValidSchema("scenarioPlan", plan, "compiled AEE scenario plan");
  return plan;
}

export function renderScenarioPlan(plan: ScenarioPlan): string {
  const lines = [
    `AEE assessment plan: ${plan.scenarioId}`,
    "",
    `Target: ${plan.target}`,
    `Goal: ${plan.goal}`,
    `Standard: ${plan.standard}`,
    `Profile: ${plan.profile}`,
    `Readiness: ${plan.readiness.status.toUpperCase()} — ${plan.readiness.summary}`,
    `Approval: ${plan.approval.status.toUpperCase()}`,
    `Plan digest: ${plan.planDigest}`,
    "",
    "Required capabilities:"
  ];

  for (const capability of plan.requiredCapabilities) {
    lines.push(
      `  ${statusMarker(capability.implementationStatus)} ${capability.label} — ${capability.implementationStatus}`
    );
  }

  for (const journey of plan.journeys) {
    lines.push(
      "",
      `Journey: ${journey.name}`,
      `Goal: ${journey.goal}`,
      `Start: ${journey.startUrl}`
    );
    journey.steps.forEach((plannedStep, index) => {
      lines.push(`  ${index + 1}. ${plannedStep.label}`);
    });
  }

  lines.push("", "Allowed actions:");
  plan.safety.allowedActions.forEach((action) => lines.push(`  + ${action}`));
  lines.push("", "Forbidden actions:");
  plan.safety.forbiddenActions.forEach((action) => lines.push(`  - ${action}`));
  lines.push("", "Allowed origins:");
  plan.safety.allowedOrigins.forEach((origin) => lines.push(`  • ${origin}`));
  lines.push(
    "",
    `Privacy: evidence storage is ${plan.privacy.storage}; remote upload is ${plan.privacy.remoteUpload}; sharing review is required.`
  );

  if (plan.readiness.status === "blocked") {
    lines.push(
      "",
      "Execution is blocked for this profile. AEE will not convert a partial run into an overall pass."
    );
  } else if (plan.approval.status !== "approved") {
    lines.push(
      "",
      "To approve this exact plan, copy its plan digest into approval.approvedPlanDigest and run aee plan again."
    );
  }

  return `${lines.join("\n")}\n`;
}

function validateScenarioSemantics(scenario: AeeScenario): void {
  const journeyIds = scenario.journeys.map(({ id }) => id);
  const duplicateJourneyIds = duplicates(journeyIds);

  if (duplicateJourneyIds.length > 0) {
    throw new Error(`Scenario journey IDs must be unique: ${duplicateJourneyIds.join(", ")}`);
  }

  if (scenario.target.allowedOrigins) {
    const targetOrigin = new URL(scenario.target.url).origin;
    const allowedOrigins = new Set(
      scenario.target.allowedOrigins.map((allowedOrigin) => new URL(allowedOrigin).origin)
    );

    if (!allowedOrigins.has(targetOrigin)) {
      throw new Error(
        `Scenario target origin ${targetOrigin} must be listed in target.allowedOrigins.`
      );
    }
  }

  for (const journey of scenario.journeys) {
    const forbidden = new Set(journey.forbiddenActions);
    const conflicts = journey.allowedActions.filter((action) => forbidden.has(action));

    if (conflicts.length > 0) {
      throw new Error(
        `Journey “${journey.id}” cannot both allow and forbid: ${uniqueSorted(conflicts).join(", ")}`
      );
    }
  }
}

function capability(
  id: string,
  label: string,
  kind: ScenarioCapability["kind"],
  implementationStatus: ImplementationStatus
): ScenarioCapability {
  return {
    id,
    label,
    kind,
    requirement: "required",
    implementationStatus
  };
}

function step(id: string, label: string): ScenarioPlan["journeys"][number]["steps"][number] {
  return { id, label, source: "profile" };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }

  return [...duplicateValues].sort((left, right) => left.localeCompare(right));
}

function humanize(value: string): string {
  return value.replaceAll("-", " ");
}

function statusMarker(status: ImplementationStatus): string {
  if (status === "available") return "✓";
  if (status === "partial") return "◐";
  return "○";
}
