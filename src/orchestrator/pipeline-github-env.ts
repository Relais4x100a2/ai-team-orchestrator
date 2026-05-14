import type { BacklogIssue } from "../backlog.js";

export function isPipelineArchitectCloud(): boolean {
  const v = process.env.PIPELINE_ARCHITECT_CLOUD?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function isGithubCloseIssueOnPipelineDoneEnabled(): boolean {
  const v = process.env.GITHUB_CLOSE_ISSUE_ON_PIPELINE_DONE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function githubPipelineCloseComment(issue: BacklogIssue, backlogDocumentId?: string): string {
  return [
    "Fermé automatiquement après `pipeline next` réussi (ai-team-orchestrator).",
    ...(backlogDocumentId ? [`- **Document backlog** : \`${backlogDocumentId}\``] : []),
    `- Story backlog : \`${issue.id}\``,
    `- pipelineRun : \`${issue.pipelineRun ?? "—"}\``,
  ].join("\n");
}
