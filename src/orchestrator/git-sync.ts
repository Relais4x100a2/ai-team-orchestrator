import { execFileSync } from "child_process";
import type { AgentRole } from "../agent-config.js";
import type { OrchestratorSession } from "./session.js";

export function resolveRepoUrl(session: OrchestratorSession): string | undefined {
  const fromProject = session.activeProject?.repo?.trim();
  const fromEnv = process.env.TARGET_REPO_URL?.trim();
  const url = fromProject || fromEnv;
  return url || undefined;
}

export function requireRepoUrlForCloud(session: OrchestratorSession, cloud?: boolean): void {
  if (!cloud) return;
  if (!resolveRepoUrl(session)) {
    console.error(
      "❌ Mode cloud : un dépôt Git cible est obligatoire.\n" +
        "   Passe --project projects/<fichier>.md (frontmatter avec `repo:`).",
    );
    process.exit(1);
  }
}

function isEnvEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  return !["0", "false", "no", "off"].includes(normalized);
}

function resolveGitSyncMode(): "safe" | "aggressive" {
  const raw = process.env.AUTO_GIT_SYNC_MODE?.trim().toLowerCase();
  return raw === "aggressive" ? "aggressive" : "safe";
}

function shouldSyncRole(role: AgentRole): boolean {
  const raw = process.env.AUTO_GIT_SYNC_ROLES?.trim().toLowerCase();
  const defaultRoles = new Set<AgentRole>(["dev", "security", "qa"]);
  if (!raw) return defaultRoles.has(role);
  if (raw === "all") return true;
  const roles = new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
  return roles.has(role);
}

export function runGit(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" }).trim();
}

export function syncLocalGitBeforeAgent(session: OrchestratorSession, role: AgentRole): void {
  if (!isEnvEnabled(process.env.AUTO_GIT_SYNC_BEFORE_AGENT, true)) return;
  if (!shouldSyncRole(role)) return;
  const repoDir = session.activeProject?.localPath ?? process.cwd();

  let isGitRepo = false;
  try {
    isGitRepo = runGit(repoDir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    isGitRepo = false;
  }
  if (!isGitRepo) return;

  const branch = runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const mode = resolveGitSyncMode();
  console.log(`   🔄 Git sync pré-agent (${role}) sur ${branch} [mode=${mode}]…`);

  const dirty = runGit(repoDir, ["status", "--porcelain"]);
  if (dirty) {
    console.warn("   ⚠️  Git sync ignoré : working tree non propre (commit/stash requis).");
    return;
  }

  runGit(repoDir, ["fetch", "--prune"]);

  try {
    runGit(repoDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    console.warn("   ⚠️  Git sync ignoré : aucune upstream branch configurée.");
    return;
  }

  const counts = runGit(repoDir, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  const [aheadRaw = "0", behindRaw = "0"] = counts.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw, 10) || 0;
  const behind = Number.parseInt(behindRaw, 10) || 0;

  if (ahead > 0 && behind > 0) {
    console.warn("   ⚠️  Git sync partiel : branche divergente (rebase/merge manuel requis).");
    return;
  }

  if (mode === "aggressive" && ahead > 0) {
    runGit(repoDir, ["push"]);
    console.log(`   ✅ Push effectué (${ahead} commit(s) en avance).`);
  } else if (ahead > 0) {
    console.log(`   ℹ️  ${ahead} commit(s) en avance (push auto désactivé en mode safe).`);
  }

  if (behind > 0) {
    runGit(repoDir, ["pull", "--ff-only"]);
    console.log(`   ✅ Pull effectué (${behind} commit(s) en retard).`);
  }

  if (ahead === 0 && behind === 0) {
    console.log("   ✅ Git déjà synchronisé.");
  }
}
