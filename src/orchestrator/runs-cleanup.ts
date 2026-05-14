import { existsSync, realpathSync, rmSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import type { Backlog, BacklogIssue } from "../backlog.js";
import { resolveLastRunDir, saveLastRunContextPruneRunsPrefix } from "./run-context.js";
import type { OrchestratorSession } from "./session.js";

function isTruthyEnv(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function shouldCleanupOnDone(): boolean {
  return isTruthyEnv("RUNS_CLEANUP_ON_ISSUE_DONE");
}

function shouldCleanupOnSkipped(): boolean {
  return isTruthyEnv("RUNS_CLEANUP_ON_SKIPPED");
}

/**
 * Supprime `runs/<backlogDocumentId>/<issueId>/` sous le répertoire de données si opt-in env activé.
 * Garde : le chemin résolu doit rester sous `lastRunDir`.
 */
export function removeRunArtifactsForClosedIssue(
  session: OrchestratorSession,
  backlog: Backlog,
  issue: BacklogIssue,
  status: "done" | "skipped",
): void {
  if (status === "done" && !shouldCleanupOnDone()) return;
  if (status === "skipped" && !shouldCleanupOnSkipped()) return;
  if (!session.activeProjectSlug || !backlog.backlogDocumentId) return;

  const lastRunDir = resolveLastRunDir(session);
  const docId = backlog.backlogDocumentId.trim();
  const issueId = issue.id.trim();
  if (!docId || !issueId || issueId.includes("..") || docId.includes("..")) return;

  const targetDir = resolve(lastRunDir, "runs", docId, issueId);
  if (!existsSync(targetDir)) return;

  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = realpathSync(resolve(lastRunDir));
    targetReal = realpathSync(targetDir);
  } catch {
    console.warn(`   ⚠️  Nettoyage runs/ : résolution de chemin impossible — ignoré`);
    return;
  }
  const relGuard = relative(rootReal, targetReal);
  if (!relGuard || relGuard.startsWith("..") || isAbsolute(relGuard)) {
    console.warn(`   ⚠️  Nettoyage runs/ : cible hors répertoire de données — ignoré`);
    return;
  }

  rmSync(targetDir, { recursive: true, force: true });
  console.log(`   🗑️  Artefacts runs supprimés : runs/${docId}/${issueId}/`);

  const prefix = `runs/${docId}/${issueId}/`;
  saveLastRunContextPruneRunsPrefix(session, lastRunDir, prefix);
}
