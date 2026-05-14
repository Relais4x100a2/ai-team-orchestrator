import type { PipelineStep } from "../agent-config.js";
import type { IssueSize } from "../backlog.js";
import { pickNextIssue } from "../backlog.js";
import {
  closeGitHubIssueWithComment,
  fetchIssueComments,
  formatIssueCommentsForBrief,
  pullIssuesFromGitHub,
  syncBacklogToGitHub,
} from "../github-sync.js";
import { newPipelineRunId } from "../models.js";
import { formatErrorMessage } from "./paths-and-env.js";
import { clearLastRunPrUrl } from "./run-context.js";
import {
  loadBacklog,
  resolveBacklogRelativePathForSync,
  saveBacklog,
  printBacklogSummary,
} from "./backlog-io.js";
import { ensureBacklogWorkBranch } from "./backlog-work-branch.js";
import { removeRunArtifactsForClosedIssue } from "./runs-cleanup.js";
import { runExecutionPipeline } from "./pipeline-execution-run.js";
import {
  githubPipelineCloseComment,
  isGithubCloseIssueOnPipelineDoneEnabled,
} from "./pipeline-github-env.js";
import { issueBacklogClosureForRunStatus } from "./pipeline-next-closure.js";
import { runMergePilotAfterPipeline } from "./pipeline-merge-pilot.js";
import type { OrchestratorSession } from "./session.js";

async function syncGitHubIfConfigured(session: OrchestratorSession): Promise<void> {
  const repo = session.activeProject?.repo?.trim();
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!repo || !token) return;

  console.log("\n🔄 Sync GitHub Issues ↔ backlog…");
  const backlog = loadBacklog(session);
  let changed = false;

  try {
    const pullResult = await pullIssuesFromGitHub(backlog, repo, token, { importNew: false });
    if (pullResult.statusClosed) {
      console.log(`   ✅ ${pullResult.statusClosed} issue(s) marquée(s) done (fermées sur GitHub)`);
      changed = true;
    }
    if (pullResult.labelsUpdated) {
      console.log(`   🏷️  ${pullResult.labelsUpdated} issue(s) avec labels mis à jour`);
      changed = true;
    }
    if (pullResult.conflicts) {
      console.log(`   ⚠️  ${pullResult.conflicts} conflit(s) ignoré(s) (in_progress)`);
    }

    const relPath = resolveBacklogRelativePathForSync(session);
    const created = await syncBacklogToGitHub(backlog, repo, token, { backlogRelativePath: relPath });
    if (created > 0) changed = true;
  } catch (e) {
    console.warn(`   ⚠️  Sync GitHub ignoré : ${(e as Error).message}`);
  }

  if (changed) saveBacklog(session, backlog);
  console.log("");
}

export type PipelineNextOptions = {
  resumeFrom?: PipelineStep;
};

export async function pipelineNext(session: OrchestratorSession, opts: PipelineNextOptions = {}): Promise<void> {
  await syncGitHubIfConfigured(session);
  const backlog = loadBacklog(session);
  const issue = pickNextIssue(backlog);

  if (!issue) {
    console.log("🎉 Backlog vide — aucune issue à traiter (todo + non-WONT).");
    printBacklogSummary(session, backlog);
    return;
  }

  await ensureBacklogWorkBranch(session, backlog);
  clearLastRunPrUrl(session);

  const docId = backlog.backlogDocumentId!.trim();
  session.agentOutputRelativeSubdir = `runs/${docId}/${issue.id}`;

  console.log(`\n▶ Issue sélectionnée : [${issue.id}] ${issue.title}`);
  console.log(`  Priorité: ${issue.priority} | Taille: ${issue.size}`);
  console.log("─".repeat(60));

  issue.status = "in_progress";
  issue.updatedAt = new Date().toISOString();
  const pipelineRunId = newPipelineRunId();
  issue.pipelineRun = pipelineRunId;
  saveBacklog(session, backlog);

  const issueRef = issue.githubIssueNumber
    ? `\n\nCette implémentation doit refermer l'issue GitHub #${issue.githubIssueNumber} — inclure \`close #${issue.githubIssueNumber}\` dans le message de commit ou la description de PR.`
    : "";

  let githubCommentsBlock = "";
  {
    const ghNum = issue.githubIssueNumber;
    const repo = session.activeProject?.repo?.trim();
    const ghToken = process.env.GITHUB_TOKEN?.trim();
    if (ghNum != null && repo && ghToken) {
      try {
        const comments = await fetchIssueComments(repo, ghToken, ghNum);
        if (comments.length > 0) {
          githubCommentsBlock = "\n\n" + formatIssueCommentsForBrief(ghNum, comments);
          console.log(`   💬 ${comments.length} commentaire(s) GitHub récupéré(s) pour #${ghNum}`);
        }
      } catch (e) {
        console.warn(`   ⚠️  Commentaires GitHub #${ghNum} : ${formatErrorMessage(e)}`);
      }
    }
  }

  try {
    const executionStartBySize: Record<IssueSize, PipelineStep> = {
      S: "dev",
      M: "architect",
      L: "architect",
      XL: "architect",
    };
    const executionStart = opts.resumeFrom ?? executionStartBySize[issue.size];
    const outcome = await runExecutionPipeline(session, issue.description + issueRef + githubCommentsBlock, {
      pipelineRunId,
      issueSize: issue.size,
      resumeFrom: executionStart,
      startReason: opts.resumeFrom
        ? "--resume-from explicite"
        : `routing pipeline next (taille ${issue.size})`,
      executionIssueInfo: { id: issue.id, title: issue.title, priority: issue.priority, size: issue.size },
      executionIssueBacklogFields:
        issue.architectureVision || issue.reflectionChallenge
          ? {
              architectureVision: issue.architectureVision,
              reflectionChallenge: issue.reflectionChallenge,
            }
          : undefined,
    });

    await runMergePilotAfterPipeline(session, backlog, issue, outcome);

    const freshBacklog = loadBacklog(session);
    const freshIssue = freshBacklog.issues.find((i) => i.id === issue.id)!;
    const closure = issueBacklogClosureForRunStatus(outcome.runStatus, new Date().toISOString());
    freshIssue.status = closure.status;
    freshIssue.completedAt = closure.completedAt;
    freshIssue.updatedAt = new Date().toISOString();
    saveBacklog(session, freshBacklog);

    if (closure.status === "done") {
      removeRunArtifactsForClosedIssue(session, freshBacklog, freshIssue, "done");

      const ghNum = freshIssue.githubIssueNumber;
      const repo = session.activeProject?.repo?.trim();
      const ghToken = process.env.GITHUB_TOKEN?.trim();
      if (isGithubCloseIssueOnPipelineDoneEnabled() && ghNum != null && repo && ghToken) {
        try {
          await closeGitHubIssueWithComment(
            repo,
            ghToken,
            ghNum,
            githubPipelineCloseComment(freshIssue, freshBacklog.backlogDocumentId),
          );
        } catch (e) {
          console.warn(`GitHub fermeture automatique : ${formatErrorMessage(e)}`);
        }
      }
    }

    if (closure.logLabel === "DONE") {
      console.log(`\n✅ Issue ${issue.id} marquée DONE dans backlog.json`);
    } else {
      console.log(
        `\n⚠️ Issue ${issue.id} laissée in_progress dans backlog.json (run pipeline ${outcome.runStatus})`,
      );
    }
  } catch (err) {
    const freshBacklog = loadBacklog(session);
    const freshIssue = freshBacklog.issues.find((i) => i.id === issue.id)!;
    freshIssue.status = "todo";
    freshIssue.pipelineRun = null;
    freshIssue.updatedAt = new Date().toISOString();
    saveBacklog(session, freshBacklog);
    throw err;
  } finally {
    session.agentOutputRelativeSubdir = null;
    session.backlogWorkBranch = null;
  }
}
