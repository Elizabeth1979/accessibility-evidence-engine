import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  overallVerdict,
  PR_COMMENT_MARKER,
  renderPullRequestSummary,
  type ScenarioIntegratedReport
} from "./scenario-runner";

/** When a run fails its job: on a blocking finding, also on an undecided one, or never. */
export type FailOn = "blocking" | "incomplete" | "never";

export const FAIL_ON_VALUES: readonly FailOn[] = ["blocking", "incomplete", "never"];

/**
 * Every assessment report under the given folders, in path order. An assessment is the folder
 * that holds a PR comment; each checkpoint's own run report below it is not one.
 */
export async function findAssessmentReports(folders: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const folder of folders) {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    );
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "aee-pr-comment.md") {
        found.push(path.join(entry.parentPath, "aee-report.json"));
      }
    }
  }
  return found.sort();
}

export function failsOn(verdict: ScenarioIntegratedReport["verdict"], failOn: FailOn): boolean {
  if (failOn === "never") return false;
  return failOn === "blocking" ? verdict === "fail" : verdict !== "pass";
}

export interface CommentResult {
  body: string;
  verdict: ScenarioIntegratedReport["verdict"];
  reports: number;
}

/** Reads a run's assessments and renders the one comment for them. */
export async function buildPullRequestComment(
  folders: string[],
  runUrl?: string
): Promise<CommentResult> {
  const reports: ScenarioIntegratedReport[] = [];
  for (const file of await findAssessmentReports(folders)) {
    reports.push(JSON.parse(await readFile(file, "utf8")) as ScenarioIntegratedReport);
  }
  return {
    body: renderPullRequestSummary(reports, runUrl),
    verdict: overallVerdict(reports),
    reports: reports.length
  };
}

export interface StickyCommentTarget {
  /** owner/name */
  repository: string;
  pullNumber: number;
  token: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Keeps one AEE comment on a pull request: the first run creates it, and every later run updates
 * the comment that starts with the marker, so re-runs never pile up comments.
 */
export async function postStickyComment(
  body: string,
  target: StickyCommentTarget
): Promise<{ action: "created" | "updated"; url: string }> {
  const request = target.fetch ?? globalThis.fetch;
  const api = (target.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${target.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const call = async (method: string, url: string, payload?: unknown) => {
    const response = await request(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    if (!response.ok) {
      throw new Error(
        `GitHub ${method} ${url} answered ${response.status}: ${await response.text()}`
      );
    }
    return response.json() as Promise<unknown>;
  };

  const issueComments = `${api}/repos/${target.repository}/issues/${target.pullNumber}/comments`;
  for (let page = 1; ; page += 1) {
    const comments = (await call("GET", `${issueComments}?per_page=100&page=${page}`)) as Array<{
      id: number;
      body?: string;
    }>;
    const existing = comments.find(({ body: text }) => text?.startsWith(PR_COMMENT_MARKER));
    if (existing) {
      const updated = (await call(
        "PATCH",
        `${api}/repos/${target.repository}/issues/comments/${existing.id}`,
        { body }
      )) as { html_url: string };
      return { action: "updated", url: updated.html_url };
    }
    if (comments.length < 100) break;
  }
  const created = (await call("POST", issueComments, { body })) as { html_url: string };
  return { action: "created", url: created.html_url };
}
