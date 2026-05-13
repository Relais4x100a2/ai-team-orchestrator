import type { Backlog, BacklogIssue } from "../backlog.js";
import {
  assertPullRequestRepoMatchesProject,
  fetchPullRequest,
  isGithubMergePrOnCiOkEnabled,
  mergePullRequestAfterCi,
  parsePullRequestNumberFromUrl,
  resolveGithubCiPollIntervalMs,
  resolveGithubCiWaitTimeoutMs,
  resolveGithubMergeMethod,
  validatePullRequestForRun,
} from "../github-pr-pipeline.js";
import { extractOwnerRepo } from "../github-sync.js";
import { detectQAVerdict, detectSecurityVerdict } from "../pipeline-detection.js";
import { readRunArtifactText, resolvePipelinePrUrl } from "./pipeline-pr-resolve.js";
import type { PipelineExecutionOutcome } from "./pipeline-types.js";
import type { OrchestratorSession } from "./session.js";

function assertMergePilotVerdicts(outcome: PipelineExecutionOutcome): void {
  if (outcome.qaEscalated || outcome.securityEscalated || outcome.mediumSecurityNotes) {
    throw new Error(
      "Pilote merge : run partiel (escalade QA/sécurité ou notes moyennes) — merge refusé.",
    );
  }
  if (outcome.lastQaVerdict === "REQUEST_CHANGES") {
    throw new Error("Pilote merge : dernier verdict QA = REQUEST_CHANGES.");
  }
  if (outcome.lastSecurityVerdict === "CRITICAL_ISSUES") {
    throw new Error("Pilote merge : dernier verdict sécurité = CRITICAL_ISSUES.");
  }
  if (!outcome.lastQaVerdict) {
    throw new Error("Pilote merge : verdict QA indétectable.");
  }
  if (!outcome.lastSecurityVerdict) {
    throw new Error("Pilote merge : verdict sécurité indétectable.");
  }
}

function reinforceVerdictsFromArtifacts(
  session: OrchestratorSession,
  outcome: PipelineExecutionOutcome,
): PipelineExecutionOutcome {
  const qaText = readRunArtifactText(session, "qa.md");
  const securityText = readRunArtifactText(session, "security.md");
  return {
    ...outcome,
    lastQaVerdict: qaText ? detectQAVerdict(qaText) : outcome.lastQaVerdict,
    lastSecurityVerdict: securityText ? detectSecurityVerdict(securityText) : outcome.lastSecurityVerdict,
  };
}

export async function runMergePilotAfterPipeline(
  session: OrchestratorSession,
  backlog: Backlog,
  _issue: BacklogIssue,
  outcome: PipelineExecutionOutcome,
): Promise<void> {
  if (!isGithubMergePrOnCiOkEnabled()) return;

  const repo = session.activeProject?.repo?.trim();
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!repo || !token) {
    throw new Error("Pilote merge : `repo:` projet et GITHUB_TOKEN requis.");
  }

  const enriched = reinforceVerdictsFromArtifacts(session, outcome);
  assertMergePilotVerdicts(enriched);

  const prUrl = resolvePipelinePrUrl(session, { mode: "mergePilot", outcome: enriched });
  if (!prUrl) {
    throw new Error("Pilote merge : aucune URL de PR dans la sortie dev ni dans run-context.json.");
  }
  assertPullRequestRepoMatchesProject(prUrl, repo);
  const prNumber = parsePullRequestNumberFromUrl(prUrl);
  if (prNumber == null) {
    throw new Error(`Pilote merge : URL PR non résoluble (numéro) : ${prUrl}`);
  }

  const ownerRepo = extractOwnerRepo(repo);
  const expectedBase = session.activeProject!.branch?.trim();
  if (!expectedBase) {
    throw new Error("Pilote merge : champ branch: du projet vide.");
  }

  let pr = await fetchPullRequest(ownerRepo, token, prNumber);
  validatePullRequestForRun({
    pr,
    expectedBaseRef: expectedBase,
    expectedHeadRef: session.backlogWorkBranch?.trim() || undefined,
    backlogDocumentId: backlog.backlogDocumentId?.trim() || undefined,
  });

  console.log(`\n🔀 Pilote merge : attente CI puis merge PR #${prNumber} (${pr.headRef} → ${pr.baseRef})…`);

  pr = await mergePullRequestAfterCi(ownerRepo, token, prNumber, {
    method: resolveGithubMergeMethod(),
    timeoutMs: resolveGithubCiWaitTimeoutMs(),
    pollIntervalMs: resolveGithubCiPollIntervalMs(),
  });

  console.log(`   ✅ PR #${prNumber} mergée (${pr.htmlUrl || prUrl}).`);
}
