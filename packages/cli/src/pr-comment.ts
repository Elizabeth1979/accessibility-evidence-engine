import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { commentImages } from "./comment-images";
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
  /** The pictures the comment shows, by file name, to upload before it is posted. */
  images: Map<string, Buffer>;
}

/**
 * Reads a run's assessments and renders the one comment for them. With `imageUrl`, each problem it
 * shows, up to a limit, gets a picture of the element on its page, at the address `imageUrl` gives.
 */
export async function buildPullRequestComment(
  folders: string[],
  runUrl?: string,
  imageUrl?: (name: string) => string
): Promise<CommentResult> {
  const assessments: Array<{ report: ScenarioIntegratedReport; dir: string }> = [];
  for (const file of await findAssessmentReports(folders)) {
    assessments.push({
      report: JSON.parse(await readFile(file, "utf8")) as ScenarioIntegratedReport,
      dir: path.dirname(file)
    });
  }
  const reports = assessments.map(({ report }) => report);
  const pictures = imageUrl ? commentImages(assessments, imageUrl) : undefined;
  return {
    body: renderPullRequestSummary(reports, runUrl, pictures?.imageFor),
    verdict: overallVerdict(reports),
    reports: reports.length,
    images: pictures?.files ?? new Map()
  };
}

/** A repository on GitHub, and what AEE needs to call its API. */
export interface GitHubTarget {
  /** owner/name */
  repository: string;
  token: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface StickyCommentTarget extends GitHubTarget {
  pullNumber: number;
}

/**
 * Calls GitHub's REST API as the target's token. A call marked optional answers nothing for a 404,
 * such as for a branch that does not exist yet; any other failure throws with GitHub's answer.
 */
function gitHubApi(target: GitHubTarget) {
  const request = target.fetch ?? globalThis.fetch;
  const api = (target.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${target.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const call = async (method: string, url: string, payload?: unknown, optional = false) => {
    const response = await request(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    if (optional && response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `GitHub ${method} ${url} answered ${response.status}: ${await response.text()}`
      );
    }
    return response.json() as Promise<unknown>;
  };
  return { repo: `${api}/repos/${target.repository}`, api, call };
}

/** The branch the comment's pictures are kept on, apart from the project's own code. */
export const COMMENT_IMAGE_BRANCH = "aee-images";

/** Where a picture uploaded to the images branch is shown from. */
export function commentImageUrl(serverUrl: string, repository: string, name: string): string {
  return `${serverUrl.replace(/\/$/, "")}/${repository}/raw/${COMMENT_IMAGE_BRANCH}/${name}`;
}

/**
 * Commits the comment's pictures to the images branch, creating it on first use, before the
 * comment that shows them is posted. Pictures are named by their content, so one already on the
 * branch adds nothing, and earlier comments keep theirs.
 */
export async function uploadCommentImages(
  files: Map<string, Buffer>,
  target: GitHubTarget
): Promise<void> {
  if (files.size === 0) return;
  const { repo, call } = gitHubApi(target);
  const ref = (await call(
    "GET",
    `${repo}/git/ref/heads/${COMMENT_IMAGE_BRANCH}`,
    undefined,
    true
  )) as { object: { sha: string } } | undefined;
  const parent = ref?.object.sha;
  const baseTree = parent
    ? ((await call("GET", `${repo}/git/commits/${parent}`)) as { tree: { sha: string } }).tree.sha
    : undefined;
  const entries = [];
  for (const [name, data] of files) {
    const blob = (await call("POST", `${repo}/git/blobs`, {
      content: data.toString("base64"),
      encoding: "base64"
    })) as { sha: string };
    entries.push({ path: name, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = (await call("POST", `${repo}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: entries
  })) as { sha: string };
  if (tree.sha === baseTree) return;
  const commit = (await call("POST", `${repo}/git/commits`, {
    message: "Add pictures for an AEE pull-request comment",
    tree: tree.sha,
    parents: parent ? [parent] : []
  })) as { sha: string };
  if (parent) {
    await call("PATCH", `${repo}/git/refs/heads/${COMMENT_IMAGE_BRANCH}`, { sha: commit.sha });
  } else {
    await call("POST", `${repo}/git/refs`, {
      ref: `refs/heads/${COMMENT_IMAGE_BRANCH}`,
      sha: commit.sha
    });
  }
}

/**
 * Keeps one AEE comment on a pull request: the first run creates it, and every later run updates
 * the comment that starts with the marker, so re-runs never pile up comments.
 */
export async function postStickyComment(
  body: string,
  target: StickyCommentTarget
): Promise<{ action: "created" | "updated"; url: string }> {
  const { api, call } = gitHubApi(target);

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
