import type { AeePolicyOverrides } from "@aee/schemas";

/** A policy as a CLI config or a test overrides it, every part optional. */
export type { AeePolicyOverrides } from "@aee/schemas";

type Overrides<Part extends keyof AeePolicyOverrides> = NonNullable<AeePolicyOverrides[Part]>;

export type ReleasePolicy = Required<Omit<Overrides<"release">, "minimumConfidence">> &
  Pick<Overrides<"release">, "minimumConfidence">;

export type CapturePolicy = Required<Overrides<"capture">>;

export type ObserverPolicy = Required<Overrides<"observers">>;

/** A policy with every default filled in, as a run uses it. */
export interface AeePolicyConfig {
  name: string;
  release: ReleasePolicy;
  capture: CapturePolicy;
  observers: ObserverPolicy;
}

export const DEFAULT_POLICY: AeePolicyConfig = {
  name: "default",
  release: {
    failOnSeverities: ["high", "critical"],
    unknownBehavior: "warn",
    minimumConfidence: 0.5
  },
  capture: {
    includeScreenshots: true,
    includeAccessibilityTree: true,
    includeDomSnapshot: true,
    stabilizeAfterInteractionMs: 250,
    watchWithoutInputMs: 1500
  },
  observers: {
    perObserverTimeoutMs: 5000,
    continueOnObserverError: true
  }
};

export function resolvePolicyConfig(overrides?: AeePolicyOverrides): AeePolicyConfig {
  return {
    name: overrides?.name ?? DEFAULT_POLICY.name,
    release: {
      ...DEFAULT_POLICY.release,
      ...(overrides?.release ?? {})
    },
    capture: {
      ...DEFAULT_POLICY.capture,
      ...(overrides?.capture ?? {})
    },
    observers: {
      ...DEFAULT_POLICY.observers,
      ...(overrides?.observers ?? {})
    }
  };
}
