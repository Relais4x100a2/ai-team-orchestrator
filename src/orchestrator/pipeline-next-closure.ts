import type { IssueStatus } from "../backlog.js";
import type { PipelineRunStatus } from "../models.js";

export type IssueBacklogClosure = {
  status: IssueStatus;
  completedAt: string | null;
  logLabel: "DONE" | "PARTIEL";
};

export function issueBacklogClosureForRunStatus(
  runStatus: PipelineRunStatus,
  nowIso: string,
): IssueBacklogClosure {
  if (runStatus === "success") {
    return { status: "done", completedAt: nowIso, logLabel: "DONE" };
  }
  return { status: "in_progress", completedAt: null, logLabel: "PARTIEL" };
}
