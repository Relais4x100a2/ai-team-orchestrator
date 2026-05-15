import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";
import { ulid } from "ulid";
import type { Backlog } from "../backlog.js";
import type { IssuePriority, IssueStatus } from "../backlog.js";
import { isValidBacklogDocumentId, parseBacklogJson } from "../models.js";
import { BACKLOG_FALLBACK_PATH, mkdirWithDefaultGitignoreIfNeeded } from "./paths-and-env.js";
import { resolveLastRunDir } from "./run-context.js";
import type { OrchestratorSession } from "./session.js";

export function resolveBacklogPath(session: OrchestratorSession): string {
  const dataDir = session.activeProject?.projectDataDir;
  if (session.activeSprintId && dataDir) {
    return resolve(dataDir, "sprints", session.activeSprintId, "backlog.json");
  }
  if (session.activeProjectSlug) return resolve(resolveLastRunDir(session), "backlog.json");
  return BACKLOG_FALLBACK_PATH;
}

/**
 * Chemin relatif du fichier backlog pour affichage / corps d’issue GitHub
 * (dépôt cible avec `local_path`, sinon emplacement côté orchestrateur).
 */
export function resolveBacklogRelativePathForSync(session: OrchestratorSession): string {
  const abs = resolveBacklogPath(session);
  const local = session.activeProject?.localPath?.trim();
  if (local) {
    const localAbs = resolve(local);
    const rel = relative(localAbs, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      return rel.split(/[/\\]+/).join("/");
    }
  }
  if (session.activeProjectSlug) {
    return `last-run/${session.activeProjectSlug}/backlog.json`;
  }
  return "backlog.json";
}

function validateCliBacklogId(session: OrchestratorSession, backlog: Backlog, backlogPath: string): void {
  const expected = session.cliBacklogDocumentId?.trim();
  if (!expected) return;
  const got = backlog.backlogDocumentId?.trim();
  if (!got || got !== expected) {
    throw new Error(
      `--backlog-id « ${expected} » ne correspond pas au backlog chargé (${backlogPath}) : ` +
        (got ? `id document = « ${got} »` : "aucun backlogDocumentId (migration requise)."),
    );
  }
}

function migrateBacklogDocumentIdIfNeeded(session: OrchestratorSession, backlog: Backlog): boolean {
  if (backlog.backlogDocumentId && isValidBacklogDocumentId(backlog.backlogDocumentId)) {
    return false;
  }
  backlog.backlogDocumentId = ulid();
  if (backlog.version < 2) backlog.version = 2;
  return true;
}

export function loadBacklog(session: OrchestratorSession): Backlog {
  const path = resolveBacklogPath(session);
  if (!existsSync(path)) {
    const empty: Backlog = {
      version: 2,
      lastUpdated: new Date().toISOString(),
      issues: [],
      backlogDocumentId: session.cliBacklogDocumentId?.trim() || ulid(),
    };
    validateCliBacklogId(session, empty, path);
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(
      "backlog.json : JSON invalide. Corrige le fichier ou supprime-le pour repartir d'un backlog vide.",
    );
  }
  let backlog: Backlog;
  try {
    backlog = parseBacklogJson(parsed);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(`backlog.json : ${msg}`);
  }

  const migrated = migrateBacklogDocumentIdIfNeeded(session, backlog);
  validateCliBacklogId(session, backlog, path);
  if (migrated) {
    saveBacklog(session, backlog);
  }
  return backlog;
}

export function saveBacklog(session: OrchestratorSession, backlog: Backlog): void {
  if (!backlog.backlogDocumentId) {
    backlog.backlogDocumentId = ulid();
  }
  if (backlog.version < 2) backlog.version = 2;
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
  if (b.backlogDocumentId) {
    console.log(`  Document backlog : ${b.backlogDocumentId}`);
  }
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

const BACKLOG_CONTEXT_MAX_CHARS = 3000;

export function formatBacklogForContext(backlog: Backlog): string {
  const openIssues = backlog.issues.filter(
    (i) => i.status === "todo" || i.status === "in_progress",
  );
  if (openIssues.length === 0) return "";

  const header = `## Backlog existant (${openIssues.length} issue(s) ouvertes)`;
  const parts = openIssues.map((i) => {
    const raw = i.description ?? "";
    const desc = raw.slice(0, 200);
    const suffix = raw.length > 200 ? "…" : "";
    return `### ${i.id} [${i.priority} / ${i.size}] — ${i.title}\n${i.status} | ${desc}${suffix}`;
  });

  const full = `${header}\n\n${parts.join("\n\n")}`;
  if (full.length <= BACKLOG_CONTEXT_MAX_CHARS) return full;
  return full.slice(0, BACKLOG_CONTEXT_MAX_CHARS) + "\n\n[…tronqué]";
}
