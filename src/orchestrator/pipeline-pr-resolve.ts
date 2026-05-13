import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { PipelineExecutionOutcome } from "./pipeline-types.js";
import { detectGitHubPrUrl, loadLastRunContext, resolveLastRunDir } from "./run-context.js";
import type { OrchestratorSession } from "./session.js";

export function readRunArtifactText(session: OrchestratorSession, roleFile: string): string | undefined {
  const sub = session.agentOutputRelativeSubdir?.trim();
  if (!sub) return undefined;
  const path = resolve(resolveLastRunDir(session), sub, roleFile);
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

export type ResolvePipelinePrUrlInput =
  | {
      mode: "devGate";
      implementation: string;
      detectedPrUrl?: string;
    }
  | {
      mode: "mergePilot";
      outcome: PipelineExecutionOutcome;
    };

export function resolvePipelinePrUrl(
  session: OrchestratorSession,
  input: ResolvePipelinePrUrlInput,
): string | undefined {
  if (input.mode === "devGate") {
    const fromText = detectGitHubPrUrl(input.implementation);
    if (fromText) return fromText;
    const fromArg = input.detectedPrUrl?.trim();
    if (fromArg) return fromArg;
    if (session.activeProjectSlug) {
      const ctx = loadLastRunContext(resolveLastRunDir(session));
      const u = ctx?.latestPrUrl?.trim();
      if (u) return u;
    }
    return undefined;
  }

  const devText = readRunArtifactText(session, "dev.md");
  const fromDev = devText ? detectGitHubPrUrl(devText) : undefined;
  if (fromDev) return fromDev;
  if (input.outcome.detectedPrUrl?.trim()) return input.outcome.detectedPrUrl.trim();
  const ctx = loadLastRunContext(resolveLastRunDir(session));
  const fromCtx = ctx?.latestPrUrl?.trim();
  if (fromCtx) return fromCtx;
  throw new Error("Pilote merge : aucune URL de PR dans la sortie dev ni dans run-context.json.");
}
