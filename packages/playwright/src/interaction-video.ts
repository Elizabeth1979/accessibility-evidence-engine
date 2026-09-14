import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertValidSchema, CURRENT_SCHEMA_VERSION } from "@aee/schemas";

export type InteractionVideoDriver = "pointer" | "keyboard" | "portable-virtual-screen-reader";

export interface PlaywrightVideoLike {
  saveAs(filePath: string): Promise<void>;
  delete?(): Promise<void>;
}

export interface InteractionVideoActionInput {
  id: string;
  sequence: number;
  label: string;
  startedAt: string;
  finishedAt: string;
}

export interface InteractionVideoEvidence {
  videoFile: string;
  sidecarFile: string;
  captionsFile: string;
}

export interface InteractionVideoSidecar {
  schemaVersion: string;
  laneId: string;
  driver: InteractionVideoDriver;
  status: "completed" | "blocked" | "failed";
  startedAt: string;
  finishedAt: string;
  video: {
    path: string;
    mediaType: "video/webm";
    captionsPath: string;
  };
  actions: Array<{
    id: string;
    sequence: number;
    label: string;
    startedAt: string;
    finishedAt: string;
    offsetMs: number;
    durationMs: number;
  }>;
  privacy: {
    classification: "sensitive";
    reviewedForSharing: false;
    shareable: false;
  };
  diagnostics?: string[];
}

export interface PersistInteractionVideoOptions {
  video: PlaywrightVideoLike;
  rootDir: string;
  laneDir: string;
  laneId: string;
  driver: InteractionVideoDriver;
  status: InteractionVideoSidecar["status"];
  startedAt: string;
  finishedAt: string;
  actions: InteractionVideoActionInput[];
  diagnostics?: string[];
}

/** Finalizes a lane recording and writes its machine-readable timeline and WebVTT projection. */
export async function persistInteractionVideo(
  options: PersistInteractionVideoOptions
): Promise<InteractionVideoEvidence> {
  const rootDir = path.resolve(options.rootDir);
  const laneDir = path.resolve(options.laneDir);
  assertInsideRoot(rootDir, laneDir);
  await mkdir(laneDir, { recursive: true });
  const canonicalRoot = await realpath(rootDir);
  assertInsideRoot(canonicalRoot, await realpath(laneDir));

  const videoFile = path.join(laneDir, "video.webm");
  const sidecarFile = path.join(laneDir, "video.json");
  const captionsFile = path.join(laneDir, "video.vtt");
  await Promise.all(
    [videoFile, sidecarFile, captionsFile].map((filePath) => assertSafeOutputTarget(filePath))
  );
  await options.video.saveAs(videoFile);
  await options.video.delete?.();

  const laneStartedMs = Date.parse(options.startedAt);
  const actions = options.actions.map((action) => {
    const actionStartedMs = Date.parse(action.startedAt);
    const actionFinishedMs = Date.parse(action.finishedAt);
    return {
      ...action,
      offsetMs: Math.max(0, actionStartedMs - laneStartedMs),
      durationMs: Math.max(0, actionFinishedMs - actionStartedMs)
    };
  });
  const sidecar: InteractionVideoSidecar = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    laneId: options.laneId,
    driver: options.driver,
    status: options.status,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    video: {
      path: relativePath(rootDir, videoFile),
      mediaType: "video/webm",
      captionsPath: relativePath(rootDir, captionsFile)
    },
    actions,
    privacy: {
      classification: "sensitive",
      reviewedForSharing: false,
      shareable: false
    },
    ...(options.diagnostics?.length ? { diagnostics: options.diagnostics } : {})
  };

  assertValidSchema("interactionVideo", sidecar, "interaction video sidecar");
  await Promise.all([
    writeFile(captionsFile, renderInteractionVideoCaptions(actions), "utf8"),
    writeFile(sidecarFile, JSON.stringify(sidecar, null, 2), "utf8")
  ]);
  return { videoFile, sidecarFile, captionsFile };
}

export function renderInteractionVideoCaptions(
  actions: InteractionVideoSidecar["actions"]
): string {
  const cues = actions.map((action) => {
    const cueEnd = action.offsetMs + Math.max(action.durationMs, 1);
    return [
      String(action.sequence),
      `${formatVttTime(action.offsetMs)} --> ${formatVttTime(cueEnd)}`,
      action.label
    ].join("\n");
  });
  return `WEBVTT\n\n${cues.join("\n\n")}${cues.length ? "\n" : ""}`;
}

function relativePath(rootDir: string, filePath: string): string {
  assertInsideRoot(rootDir, filePath);
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function assertInsideRoot(rootDir: string, candidatePath: string): void {
  const relative = path.relative(rootDir, candidatePath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) return;
  throw new Error(`Interaction video path must stay inside ${rootDir}.`);
}

async function assertSafeOutputTarget(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new Error(`Interaction video output cannot be a symbolic link: ${filePath}`);
    }
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function formatVttTime(milliseconds: number): string {
  const normalized = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(normalized / 3_600_000);
  const minutes = Math.floor((normalized % 3_600_000) / 60_000);
  const seconds = Math.floor((normalized % 60_000) / 1_000);
  const millis = normalized % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
