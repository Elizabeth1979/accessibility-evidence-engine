import type { FindingSeverity } from "./types";

export interface ReleasePolicy {
  failOnSeverities: FindingSeverity[];
  unknownBehavior: "ignore" | "warn" | "fail";
  minimumConfidence?: number;
}

export interface CapturePolicy {
  includeScreenshots: boolean;
  includeAccessibilityTree: boolean;
  includeDomSnapshot: boolean;
  stabilizeAfterInteractionMs: number;
}

export interface ObserverPolicy {
  perObserverTimeoutMs: number;
  continueOnObserverError: boolean;
}

export interface AeePolicyConfig {
  name: string;
  release: ReleasePolicy;
  capture: CapturePolicy;
  observers: ObserverPolicy;
}

export interface AeePolicyOverrides {
  name?: string;
  release?: Partial<ReleasePolicy>;
  capture?: Partial<CapturePolicy>;
  observers?: Partial<ObserverPolicy>;
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
    stabilizeAfterInteractionMs: 250
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
