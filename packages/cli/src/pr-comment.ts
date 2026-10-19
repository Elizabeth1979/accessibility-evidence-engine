import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { RequestError } from "@octokit/request-error";

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
  /** Each assessment read, in full, with the folder its evidence paths are relative to. */
  assessments: Array<{ report: ScenarioIntegratedReport; dir: string }>;
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
    assessments,
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
 * Octokit with what posting a comment needs: pages of comments, a retry when GitHub's servers
 * briefly fail, and a wait when GitHub asks clients to slow down. Writes are spaced out as GitHub
 * asks of integrations, so a run that uploads pictures does not trip its secondary rate limit.
 */
const GitHubClient = Octokit.plugin(paginateRest, retry, throttling);

/** How often, and for how long at most, AEE waits when GitHub says to slow down. */
const RATE_LIMIT_RETRIES = 2;
const LONGEST_RATE_LIMIT_WAIT_SECONDS = 120;

/**
 * Calls GitHub's REST API as the target's token, at the target's API (GitHub Enterprise Server has
 * its own). A failure throws a RequestError naming the call, its status and GitHub's answer.
 */
function gitHubApi(target: GitHubTarget) {
  const [owner = "", repo = ""] = target.repository.split("/");
  const slowDown =
    (limit: string) =>
    (
      retryAfter: number,
      options: { method: string; url: string },
      octokit: Octokit,
      retryCount: number
    ) => {
      const next =
        retryCount >= RATE_LIMIT_RETRIES
          ? `giving up after waiting ${RATE_LIMIT_RETRIES} times`
          : retryAfter > LONGEST_RATE_LIMIT_WAIT_SECONDS
            ? `it resets in ${retryAfter} s, too long to wait`
            : undefined;
      octokit.log.warn(
        `GitHub's ${limit} was reached on ${options.method} ${options.url}; ${next ?? `trying again in ${retryAfter} s`}.`
      );
      return next === undefined;
    };
  const octokit = new GitHubClient({
    auth: target.token,
    baseUrl: (target.apiUrl ?? "https://api.github.com").replace(/\/$/, ""),
    ...(target.fetch ? { request: { fetch: target.fetch } } : {}),
    throttle: {
      onRateLimit: slowDown("hourly request limit"),
      onSecondaryRateLimit: slowDown("secondary rate limit")
    }
  });
  octokit.hook.before("request", (options) => {
    options.headers["x-github-api-version"] = "2022-11-28";
  });
  // Registered after the plugins, so it sees each call's last answer, once retries are done.
  octokit.hook.error("request", (error) => {
    if (!(error instanceof RequestError)) throw error;
    const { method, url } = error.request;
    // With no response, GitHub was never reached, and Octokit's status 500 is its own.
    const outcome = error.response ? `answered ${error.status}` : "could not be reached";
    throw new RequestError(`GitHub ${method} ${url} ${outcome}: ${error.message}`, error.status, {
      request: error.request,
      ...(error.response ? { response: error.response } : {})
    });
  });
  return { octokit, repo: { owner, repo } };
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
  const { octokit, repo } = gitHubApi(target);
  // A branch that does not exist yet is a 404.
  const parent = await octokit
    .request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      ...repo,
      ref: `heads/${COMMENT_IMAGE_BRANCH}`
    })
    .then(
      ({ data }) => data.object.sha,
      (error: unknown) => {
        if (error instanceof RequestError && error.status === 404) return undefined;
        throw error;
      }
    );
  const baseTree = parent
    ? (
        await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
          ...repo,
          commit_sha: parent
        })
      ).data.tree.sha
    : undefined;
  const entries = [];
  for (const [name, data] of files) {
    const blob = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
      ...repo,
      content: data.toString("base64"),
      encoding: "base64"
    });
    entries.push({
      path: name,
      mode: "100644" as const,
      type: "blob" as const,
      sha: blob.data.sha
    });
  }
  const tree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    ...repo,
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: entries
  });
  if (tree.data.sha === baseTree) return;
  const commit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    ...repo,
    message: "Add pictures for an AEE pull-request comment",
    tree: tree.data.sha,
    parents: parent ? [parent] : []
  });
  if (parent) {
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      ...repo,
      ref: `heads/${COMMENT_IMAGE_BRANCH}`,
      sha: commit.data.sha
    });
  } else {
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      ...repo,
      ref: `refs/heads/${COMMENT_IMAGE_BRANCH}`,
      sha: commit.data.sha
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
  const { octokit, repo } = gitHubApi(target);
  const issue = { ...repo, issue_number: target.pullNumber };

  for await (const { data: comments } of octokit.paginate.iterator(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { ...issue, per_page: 100 }
  )) {
    const existing = comments.find(({ body: text }) => text?.startsWith(PR_COMMENT_MARKER));
    if (existing) {
      const updated = await octokit.request(
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        { ...repo, comment_id: existing.id, body }
      );
      return { action: "updated", url: updated.data.html_url };
    }
  }
  const created = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { ...issue, body }
  );
  return { action: "created", url: created.data.html_url };
}
