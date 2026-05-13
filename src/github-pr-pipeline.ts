/**
 * Résolution PR, attente CI et merge GitHub (pilote `pipeline next`, opt-in env).
 */

import { extractOwnerRepo, githubApiHeaders } from "./github-sync.js";

const GITHUB_REST = "https://api.github.com/repos";

export type GithubMergeMethod = "squash" | "merge" | "rebase";

export type PullRequestDetails = {
  number: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  htmlUrl: string;
  headRepoFullName: string;
  baseRepoFullName: string;
  mergeable: boolean | null;
  mergeableState: string | null;
};

export type ValidatePullRequestForRunInput = {
  pr: PullRequestDetails;
  expectedBaseRef: string;
  expectedHeadRef?: string;
  backlogDocumentId?: string;
};

function summarizeGithubErrorBody(raw: string, max = 280): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function githubFetchError(prefix: string, res: Response, body: string): Error {
  return new Error(`${prefix} (${res.status}) — ${summarizeGithubErrorBody(body)}`);
}

function truthyEnv(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

export function isGithubMergePrOnCiOkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.GITHUB_MERGE_PR_ON_CI_OK);
}

export function resolveGithubMergeMethod(env: NodeJS.ProcessEnv = process.env): GithubMergeMethod {
  const raw = env.GITHUB_MERGE_METHOD?.trim().toLowerCase();
  if (raw === "merge" || raw === "rebase" || raw === "squash") return raw;
  return "squash";
}

export function resolveGithubCiWaitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GITHUB_CI_WAIT_TIMEOUT_MS?.trim();
  if (!raw) return 30 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30 * 60 * 1000;
}

export function resolveGithubCiPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GITHUB_CI_POLL_INTERVAL_MS?.trim();
  if (!raw) return 30 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30 * 1000;
}

/** Numéro PR depuis une URL `/pull/<n>` (pas `/pull/new/...`). */
export function parsePullRequestNumberFromUrl(url: string): number | undefined {
  const trimmed = url.trim();
  const match = trimmed.match(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#]|$)/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function ownerRepoFromGitHubWebUrl(url: string): string {
  const match = url.trim().match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\/|$)/i);
  if (!match) throw new Error(`URL GitHub non reconnue : ${url}`);
  return match[1]!;
}

export function assertPullRequestRepoMatchesProject(prUrl: string, projectRepoUrl: string): void {
  const prRepo = ownerRepoFromGitHubWebUrl(prUrl);
  const projectRepo = extractOwnerRepo(projectRepoUrl);
  if (prRepo.toLowerCase() !== projectRepo.toLowerCase()) {
    throw new Error(
      `PR hors dépôt projet : ${prRepo} (attendu ${projectRepo}).`,
    );
  }
}

function mapPullRequestDetails(data: Record<string, unknown>): PullRequestDetails {
  const head = data.head as Record<string, unknown> | undefined;
  const base = data.base as Record<string, unknown> | undefined;
  const headRepo = head?.repo as Record<string, unknown> | undefined;
  const baseRepo = base?.repo as Record<string, unknown> | undefined;
  const number = data.number;
  const headSha = head?.sha;
  const headRef = head?.ref;
  const baseRef = base?.ref;
  if (
    typeof number !== "number" ||
    typeof headSha !== "string" ||
    typeof headRef !== "string" ||
    typeof baseRef !== "string" ||
    typeof headRepo?.full_name !== "string" ||
    typeof baseRepo?.full_name !== "string"
  ) {
    throw new Error("Réponse GitHub PR incomplète (head/base).");
  }
  return {
    number,
    headRef,
    baseRef,
    headSha,
    htmlUrl: typeof data.html_url === "string" ? data.html_url : "",
    headRepoFullName: headRepo.full_name,
    baseRepoFullName: baseRepo.full_name,
    mergeable: typeof data.mergeable === "boolean" ? data.mergeable : null,
    mergeableState: typeof data.mergeable_state === "string" ? data.mergeable_state : null,
  };
}

export async function fetchPullRequest(
  ownerRepo: string,
  token: string,
  number: number,
): Promise<PullRequestDetails> {
  const res = await fetch(`${GITHUB_REST}/${ownerRepo}/pulls/${number}`, {
    headers: githubApiHeaders(token),
  });
  const body = await res.text();
  if (!res.ok) {
    throw githubFetchError(`Lecture PR #${number} impossible`, res, body);
  }
  return mapPullRequestDetails(JSON.parse(body) as Record<string, unknown>);
}

const BLOCKED_MERGEABLE_STATES = new Set(["dirty", "blocked", "behind"]);

export function validatePullRequestForRun(input: ValidatePullRequestForRunInput): void {
  const { pr, expectedBaseRef, expectedHeadRef, backlogDocumentId } = input;
  if (pr.baseRef !== expectedBaseRef.trim()) {
    throw new Error(
      `PR #${pr.number} : base « ${pr.baseRef} » ≠ branche d'intégration « ${expectedBaseRef} ».`,
    );
  }
  if (pr.headRepoFullName !== pr.baseRepoFullName) {
    throw new Error(`PR #${pr.number} : merge depuis un fork interdit (${pr.headRepoFullName}).`);
  }
  if (expectedHeadRef?.trim()) {
    if (pr.headRef !== expectedHeadRef.trim()) {
      throw new Error(
        `PR #${pr.number} : head « ${pr.headRef} » ≠ branche de travail « ${expectedHeadRef} ».`,
      );
    }
  }
  const docId = backlogDocumentId?.trim();
  if (docId && !pr.headRef.startsWith(`backlog/${docId}-`)) {
    throw new Error(
      `PR #${pr.number} : head « ${pr.headRef} » ne correspond pas au document backlog ${docId}.`,
    );
  }
  if (pr.mergeable === false) {
    throw new Error(`PR #${pr.number} : non mergeable (protections ou conflits).`);
  }
  if (pr.mergeableState && BLOCKED_MERGEABLE_STATES.has(pr.mergeableState)) {
    throw new Error(`PR #${pr.number} : état mergeable « ${pr.mergeableState} » bloquant.`);
  }
}

type CiWaitOptions = {
  timeoutMs: number;
  pollIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "error",
  "cancelled",
  "timed_out",
  "action_required",
]);

async function fetchCommitStatusState(
  ownerRepo: string,
  token: string,
  sha: string,
): Promise<string | null> {
  const res = await fetch(`${GITHUB_REST}/${ownerRepo}/commits/${sha}/status`, {
    headers: githubApiHeaders(token),
  });
  const body = await res.text();
  if (!res.ok) {
    throw githubFetchError(`Lecture statut commit ${sha.slice(0, 7)} impossible`, res, body);
  }
  const data = JSON.parse(body) as { state?: string };
  return typeof data.state === "string" ? data.state : null;
}

async function fetchCheckRunsSummary(
  ownerRepo: string,
  token: string,
  sha: string,
): Promise<{ pending: number; failed: number }> {
  const res = await fetch(`${GITHUB_REST}/${ownerRepo}/commits/${sha}/check-runs?per_page=100`, {
    headers: githubApiHeaders(token),
  });
  const body = await res.text();
  if (!res.ok) {
    throw githubFetchError(`Lecture check-runs ${sha.slice(0, 7)} impossible`, res, body);
  }
  const data = JSON.parse(body) as { check_runs?: Array<{ status?: string; conclusion?: string | null }> };
  const runs = data.check_runs ?? [];
  let pending = 0;
  let failed = 0;
  for (const run of runs) {
    if (run.status !== "completed") {
      pending++;
      continue;
    }
    const conclusion = run.conclusion ?? "";
    if (FAILED_CHECK_CONCLUSIONS.has(conclusion)) failed++;
  }
  return { pending, failed };
}

export async function waitForCommitChecksGreen(
  ownerRepo: string,
  token: string,
  sha: string,
  options: CiWaitOptions,
): Promise<void> {
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const statusState = await fetchCommitStatusState(ownerRepo, token, sha);
    const { pending, failed } = await fetchCheckRunsSummary(ownerRepo, token, sha);
    if (failed > 0) {
      throw new Error(`CI en échec sur ${sha.slice(0, 7)} (check-runs).`);
    }
    if (statusState === "failure" || statusState === "error") {
      throw new Error(`CI en échec sur ${sha.slice(0, 7)} (statut commit ${statusState}).`);
    }
    const statusOk = statusState === "success" || statusState === null;
    if (statusOk && pending === 0) {
      return;
    }
    await sleep(options.pollIntervalMs);
  }
  throw new Error(`Timeout CI (${options.timeoutMs} ms) sur ${sha.slice(0, 7)}.`);
}

export async function mergePullRequest(
  ownerRepo: string,
  token: string,
  number: number,
  method: GithubMergeMethod,
): Promise<void> {
  const res = await fetch(`${GITHUB_REST}/${ownerRepo}/pulls/${number}/merge`, {
    method: "PUT",
    headers: githubApiHeaders(token),
    body: JSON.stringify({ merge_method: method }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw githubFetchError(`Merge PR #${number} refusé`, res, body);
  }
}

export type MergePullRequestAfterCiOptions = CiWaitOptions & {
  method: GithubMergeMethod;
};

/** Re-fetch PR, attend CI sur la tête, re-fetch et merge (anti-TOCTOU sur SHA). */
export async function mergePullRequestAfterCi(
  ownerRepo: string,
  token: string,
  number: number,
  options: MergePullRequestAfterCiOptions,
): Promise<PullRequestDetails> {
  let pr = await fetchPullRequest(ownerRepo, token, number);
  const firstSha = pr.headSha;
  await waitForCommitChecksGreen(ownerRepo, token, pr.headSha, options);
  pr = await fetchPullRequest(ownerRepo, token, number);
  if (pr.headSha !== firstSha) {
    await waitForCommitChecksGreen(ownerRepo, token, pr.headSha, options);
    pr = await fetchPullRequest(ownerRepo, token, number);
  }
  if (pr.mergeable === false) {
    throw new Error(`PR #${number} : non mergeable avant merge.`);
  }
  if (pr.mergeableState && BLOCKED_MERGEABLE_STATES.has(pr.mergeableState)) {
    throw new Error(`PR #${number} : état mergeable « ${pr.mergeableState} » bloquant.`);
  }
  await mergePullRequest(ownerRepo, token, number, options.method);
  return pr;
}
