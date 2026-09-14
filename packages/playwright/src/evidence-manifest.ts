import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertValidSchema, CURRENT_SCHEMA_VERSION } from "@aee/schemas";

export type ManifestArtifactStatus = "available" | "missing" | "failed";

export interface EvidenceManifestActionSource {
  id: string;
  sequence: number;
  runId: string;
  status: "completed" | "blocked" | "failed";
  reporterFiles: string[];
  artifactFiles: string[];
  runDir?: string;
  requiredArtifactBasenames?: string[];
}

export interface EvidenceManifestLaneSource {
  id: string;
  driver: "pointer" | "keyboard" | "portable-virtual-screen-reader";
  status: "completed" | "blocked" | "failed";
  actions: EvidenceManifestActionSource[];
}

export interface EvidenceManifestSupplementalFile {
  path: string;
  kind?: EvidenceManifestArtifact["kind"];
  mediaType?: string;
  phase?: "lane" | "assessment";
  laneId?: string;
}

export interface WriteEvidenceManifestOptions {
  assessmentId: string;
  rootDir: string;
  scenarioId?: string;
  scenarioDigest?: string;
  profile?: "core" | "at-fidelity";
  lanes: EvidenceManifestLaneSource[];
  supplementalFiles?: EvidenceManifestSupplementalFile[];
  manifestFile?: string;
}

export interface EvidenceManifestArtifact {
  id: string;
  path: string;
  kind:
    | "viewport-screenshot"
    | "full-page-screenshot"
    | "dom-snapshot"
    | "accessibility-tree"
    | "focus-state"
    | "axe-result"
    | "screen-reader-transcript"
    | "interaction-video"
    | "video-sidecar"
    | "video-captions"
    | "json-report"
    | "markdown-report"
    | "run-metadata"
    | "evidence-bundle"
    | "interaction-trace"
    | "lane-metadata"
    | "custom";
  mediaType: string;
  phase: "before" | "after" | "action" | "lane" | "assessment";
  status: ManifestArtifactStatus;
  byteLength?: number;
  integrity?: string;
  observerId?: string;
  provenance: {
    laneId?: string;
    actionId?: string;
    runId?: string;
    sequence?: number;
  };
  lifecycle: "persisted";
  privacy: {
    classification: "sensitive";
    redactionStatus: "not-reviewed";
    shareable: false;
  };
  diagnostics?: string[];
}

export interface EvidenceManifest {
  schemaVersion: string;
  assessmentId: string;
  scenarioId?: string;
  scenarioDigest?: string;
  profile?: "core" | "at-fidelity";
  status: "completed" | "partial";
  createdAt: string;
  root: ".";
  lanes: Array<{
    id: string;
    driver: EvidenceManifestLaneSource["driver"];
    status: EvidenceManifestLaneSource["status"];
    actionIds: string[];
    actions: Array<{
      id: string;
      sequence: number;
      runId: string;
      status: EvidenceManifestActionSource["status"];
    }>;
  }>;
  artifacts: EvidenceManifestArtifact[];
  summary: {
    total: number;
    available: number;
    missing: number;
    failed: number;
  };
  privacy: {
    defaultClassification: "sensitive";
    reviewedForSharing: false;
    remoteUploadAuthorized: false;
  };
}

interface CandidateFile extends EvidenceManifestSupplementalFile {
  actionId?: string;
  runId?: string;
  sequence?: number;
}

/** Writes a deterministic, privacy-conservative index of required and available evidence files. */
export async function writeEvidenceManifest(
  options: WriteEvidenceManifestOptions
): Promise<{ manifest: EvidenceManifest; manifestFile: string }> {
  const rootDir = path.resolve(options.rootDir);
  const manifestFile = path.resolve(options.manifestFile ?? path.join(rootDir, "manifest.json"));
  assertInsideRoot(rootDir, manifestFile);
  await mkdir(rootDir, { recursive: true });
  const canonicalRoot = await realpath(rootDir);
  await assertSafeManifestTarget(canonicalRoot, manifestFile);
  const candidates = collectCandidates(options);
  const artifacts: EvidenceManifestArtifact[] = [];

  for (const candidate of candidates) {
    artifacts.push(await inspectCandidate(rootDir, canonicalRoot, candidate));
  }

  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const summary = {
    total: artifacts.length,
    available: artifacts.filter(({ status }) => status === "available").length,
    missing: artifacts.filter(({ status }) => status === "missing").length,
    failed: artifacts.filter(({ status }) => status === "failed").length
  };
  const manifest: EvidenceManifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    assessmentId: options.assessmentId,
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    ...(options.scenarioDigest ? { scenarioDigest: options.scenarioDigest } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    status:
      summary.missing === 0 &&
      summary.failed === 0 &&
      options.lanes.every(({ status }) => status === "completed")
        ? "completed"
        : "partial",
    createdAt: new Date().toISOString(),
    root: ".",
    lanes: options.lanes.map((lane) => ({
      id: lane.id,
      driver: lane.driver,
      status: lane.status,
      actionIds: lane.actions.map(({ id }) => id),
      actions: lane.actions.map(({ id, sequence, runId, status }) => ({
        id,
        sequence,
        runId,
        status
      }))
    })),
    artifacts,
    summary,
    privacy: {
      defaultClassification: "sensitive",
      reviewedForSharing: false,
      remoteUploadAuthorized: false
    }
  };

  assertValidSchema("evidenceManifest", manifest, "AEE evidence manifest");
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  return { manifest, manifestFile };
}

function collectCandidates(options: WriteEvidenceManifestOptions): CandidateFile[] {
  const candidates = new Map<string, CandidateFile>();
  const add = (candidate: CandidateFile) => {
    const absolutePath = path.resolve(candidate.path);
    if (!candidates.has(absolutePath))
      candidates.set(absolutePath, { ...candidate, path: absolutePath });
  };

  for (const lane of options.lanes) {
    for (const action of lane.actions) {
      const provenance = {
        laneId: lane.id,
        actionId: action.id,
        runId: action.runId,
        sequence: action.sequence
      };
      action.reporterFiles.forEach((filePath) => add({ path: filePath, ...provenance }));
      action.artifactFiles.forEach((filePath) => add({ path: filePath, ...provenance }));

      const runDir =
        action.runDir ??
        (action.reporterFiles[0] ? path.dirname(action.reporterFiles[0]) : undefined);
      if (runDir) {
        add({ path: path.join(runDir, "aee-report.json"), ...provenance });
        add({ path: path.join(runDir, "aee-report.md"), ...provenance });
        add({ path: path.join(runDir, "run.json"), ...provenance });
        add({ path: path.join(runDir, "bundle.json"), ...provenance });
        for (const basename of action.requiredArtifactBasenames ?? []) {
          add({ path: path.join(runDir, "artifacts", basename), ...provenance });
        }
      }
    }
  }

  options.supplementalFiles?.forEach(add);
  return [...candidates.values()];
}

async function inspectCandidate(
  rootDir: string,
  canonicalRoot: string,
  candidate: CandidateFile
): Promise<EvidenceManifestArtifact> {
  const absolutePath = path.resolve(candidate.path);
  assertInsideRoot(rootDir, absolutePath);
  const relativePath = toPosixPath(path.relative(rootDir, absolutePath));
  const inferred = inferArtifactMetadata(relativePath, candidate);
  const base: Omit<EvidenceManifestArtifact, "status"> = {
    id: artifactId(relativePath),
    path: relativePath,
    kind: candidate.kind ?? inferred.kind,
    mediaType: candidate.mediaType ?? inferred.mediaType,
    phase: candidate.phase ?? inferred.phase,
    ...(inferred.observerId ? { observerId: inferred.observerId } : {}),
    provenance: {
      ...(candidate.laneId ? { laneId: candidate.laneId } : {}),
      ...(candidate.actionId ? { actionId: candidate.actionId } : {}),
      ...(candidate.runId ? { runId: candidate.runId } : {}),
      ...(candidate.sequence !== undefined ? { sequence: candidate.sequence } : {})
    },
    lifecycle: "persisted",
    privacy: {
      classification: "sensitive",
      redactionStatus: "not-reviewed",
      shareable: false
    }
  };

  try {
    const fileStats = await lstat(absolutePath);
    if (fileStats.isSymbolicLink()) {
      return { ...base, status: "failed", diagnostics: ["Symbolic-link evidence is not read."] };
    }
    const canonicalPath = await realpath(absolutePath);
    assertInsideRoot(canonicalRoot, canonicalPath);
    const content = await readFile(absolutePath);
    if (!fileStats.isFile()) {
      return { ...base, status: "failed", diagnostics: ["Referenced path is not a file."] };
    }
    return {
      ...base,
      status: "available",
      byteLength: fileStats.size,
      integrity: `sha256:${createHash("sha256").update(content).digest("hex")}`
    };
  } catch (error) {
    const code = getErrorCode(error);
    return {
      ...base,
      status: code === "ENOENT" ? "missing" : "failed",
      diagnostics: [
        code === "ENOENT"
          ? "Required evidence file was not created."
          : "Evidence file could not be inspected."
      ]
    };
  }
}

async function assertSafeManifestTarget(
  canonicalRoot: string,
  manifestFile: string
): Promise<void> {
  const parent = path.dirname(manifestFile);
  await mkdir(parent, { recursive: true });
  assertInsideRoot(canonicalRoot, await realpath(parent));
  try {
    const existing = await lstat(manifestFile);
    if (existing.isSymbolicLink()) {
      throw new Error("Manifest output cannot be a symbolic link.");
    }
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
}

function inferArtifactMetadata(
  relativePath: string,
  candidate: CandidateFile
): Pick<EvidenceManifestArtifact, "kind" | "mediaType" | "phase" | "observerId"> {
  const basename = path.posix.basename(relativePath);
  const phase = basename.includes("-before.")
    ? "before"
    : basename.includes("-after.")
      ? "after"
      : candidate.actionId
        ? "action"
        : "lane";
  if (basename.startsWith("visual-viewport-"))
    return metadata("viewport-screenshot", "image/png", phase, "visual");
  if (basename.startsWith("visual-full-page-"))
    return metadata("full-page-screenshot", "image/png", phase, "visual");
  if (basename.startsWith("dom-")) return metadata("dom-snapshot", "text/html", phase, "dom");
  if (basename.startsWith("accessibility-tree-"))
    return metadata("accessibility-tree", "application/json", phase, "accessibility-tree");
  if (basename.startsWith("focus-"))
    return metadata("focus-state", "application/json", phase, "focus");
  if (basename.startsWith("axe-")) return metadata("axe-result", "application/json", phase, "axe");
  if (
    basename.includes("virtual-screen-reader-transcript") ||
    basename === "transcript.json" ||
    basename === "transcript.txt"
  ) {
    return metadata(
      "screen-reader-transcript",
      mediaTypeForPath(basename),
      phase,
      "virtual-screen-reader"
    );
  }
  if (basename === "aee-report.json") return metadata("json-report", "application/json", "action");
  if (basename === "aee-report.md") return metadata("markdown-report", "text/markdown", "action");
  if (basename === "run.json") return metadata("run-metadata", "application/json", "action");
  if (basename === "bundle.json") return metadata("evidence-bundle", "application/json", "action");
  if (basename === "interaction-trace.json")
    return metadata("interaction-trace", "application/json", "lane");
  if (basename === "lane.json") return metadata("lane-metadata", "application/json", "lane");
  if (basename === "video.webm")
    return metadata("interaction-video", "video/webm", "lane", "video");
  if (basename === "video.json")
    return metadata("video-sidecar", "application/json", "lane", "video");
  if (basename === "video.vtt") return metadata("video-captions", "text/vtt", "lane", "video");
  return metadata("custom", mediaTypeForPath(basename), phase);
}

function metadata(
  kind: EvidenceManifestArtifact["kind"],
  mediaType: string,
  phase: EvidenceManifestArtifact["phase"],
  observerId?: string
): Pick<EvidenceManifestArtifact, "kind" | "mediaType" | "phase" | "observerId"> {
  return { kind, mediaType, phase, ...(observerId ? { observerId } : {}) };
}

function mediaTypeForPath(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".md")) return "text/markdown";
  if (filePath.endsWith(".txt")) return "text/plain";
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function artifactId(relativePath: string): string {
  const readable = relativePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-72);
  const suffix = createHash("sha256").update(relativePath).digest("hex").slice(0, 12);
  return `${readable || "artifact"}-${suffix}`;
}

function assertInsideRoot(rootDir: string, targetPath: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Manifest evidence path must remain inside its root: ${targetPath}`);
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
