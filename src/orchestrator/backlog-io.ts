import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import type { Backlog } from "../backlog.js";
import type { IssuePriority, IssueStatus } from "../backlog.js";
import { parseBacklogJson } from "../models.js";
import { BACKLOG_FALLBACK_PATH, mkdirWithDefaultGitignoreIfNeeded } from "./paths-and-env.js";
import { resolveLastRunDir } from "./run-context.js";
import type { OrchestratorSession } from "./session.js";

export function resolveBacklogPath(session: OrchestratorSession): string {
  if (session.activeProjectSlug) return resolve(resolveLastRunDir(session), "backlog.json");
  return BACKLOG_FALLBACK_PATH;
}

export function loadBacklog(session: OrchestratorSession): Backlog {
  if (!existsSync(resolveBacklogPath(session))) {
    return { version: 1, lastUpdated: new Date().toISOString(), issues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolveBacklogPath(session), "utf-8"));
  } catch {
    throw new Error(
      "backlog.json : JSON invalide. Corrige le fichier ou supprime-le pour repartir d'un backlog vide.",
    );
  }
  try {
    return parseBacklogJson(parsed);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(`backlog.json : ${msg}`);
  }
}

export function saveBacklog(session: OrchestratorSession, backlog: Backlog): void {
  backlog.lastUpdated = new Date().toISOString();
  const path = resolveBacklogPath(session);
  mkdirWithDefaultGitignoreIfNeeded(dirname(path));
  writeFileSync(path, JSON.stringify(backlog, null, 2), "utf-8");
}

export function printBacklogSummary(session: OrchestratorSession, backlog?: Backlog): void {
  const b = backlog ?? loadBacklog(session);
  const counts: Record<IssueStatus, number> = { todo: 0, in_progress: 0, done: 0, skipped: 0 };
  for (const i of b.issues) counts[i.status]++;

  console.log("\n" + "═".repeat(60));
  console.log("📦 BACKLOG — État actuel");
  console.log("═".repeat(60));
  console.log(`  Total : ${b.issues.length} issues`);
  console.log(`  Todo         : ${counts.todo}`);
  console.log(`  In progress  : ${counts.in_progress}`);
  console.log(`  Done         : ${counts.done}`);
  if (counts.skipped) console.log(`  Skipped      : ${counts.skipped}`);
  console.log("─".repeat(60));

  const statusIcon: Record<IssueStatus, string> = { todo: "⬜", in_progress: "🔄", done: "✅", skipped: "⏭️" };
  const priorities: IssuePriority[] = ["MUST", "SHOULD", "COULD", "WONT"];

  for (const priority of priorities) {
    const group = b.issues.filter((i) => i.priority === priority);
    if (group.length === 0) continue;
    console.log(`\n  [${priority}]`);
    for (const issue of group) {
      const icon = statusIcon[issue.status];
      const size = issue.size.padEnd(2);
      console.log(`  ${icon} [${size}] ${issue.id}  ${issue.title}`);
    }
  }

  console.log("\n" + "═".repeat(60));
  if (b.lastUpdated) {
    console.log(`  Dernière mise à jour : ${new Date(b.lastUpdated).toLocaleString("fr-FR")}`);
  }
}
