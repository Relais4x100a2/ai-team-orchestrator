import type { PipelineStep } from "../agent-config.js";
import type { IssueSize } from "../backlog.js";
import type { QAVerdict, SecurityVerdict } from "../pipeline-detection.js";
import type { PipelineRunStatus } from "../models.js";

export type PipelineExecutionOutcome = {
  runStatus: PipelineRunStatus;
  qaEscalated: boolean;
  securityEscalated: boolean;
  mediumSecurityNotes: boolean;
  lastQaVerdict: QAVerdict | null;
  lastSecurityVerdict: SecurityVerdict | null;
  detectedPrUrl?: string;
};

export type RunExecutionPipelineOptions = {
  resumeFrom?: PipelineStep;
  pipelineRunId?: string;
  issueSize?: IssueSize;
  startReason?: string;
  executionIssueBacklogFields?: {
    architectureVision?: string;
    reflectionChallenge?: string;
  };
  executionIssueInfo?: { id: string; title: string; priority: string; size: string };
};
