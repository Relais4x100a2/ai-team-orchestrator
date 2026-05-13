import { existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { Backlog } from "../backlog.js";
import { themeSourceForWorkBranch } from "../backlog.js";
import { buildGitHubTreeUrlForProject } from "../project-branch-url.js";
import { runGit } from "./git-sync.js";
import { formatErrorMessage } from "./paths-and-env.js";
import { LAST_RUN_CONTEXT_FILE, loadLastRunContext } from "./run-context.js";
import { resolveLastRunDir } from "./run-context.js";
import type { OrchestratorSession } from "./session.js";

const MAX_SLUG_LEN = 48;
const MAX_BRANCH_TOTAL = 200;

/** Normalise un libellé en slug ASCII pour nom de branche Git. */
export function slugifyForGitBranch(raw: string): string {
  const ascii = raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!ascii) return "backlog";
  return ascii.slice(0, MAX_SLUG_LEN);
}

function branchBaseName(backlog: Backlog): string {
  const fromTheme = backlog.themeLabel?.trim();
  const source = fromTheme || themeSourceForWorkBranch(backlog);
  return slugifyForGitBranch(source);
}

function localBranchExists(repoDir: string, shortName: string): boolean {
  try {
    runGit(repoDir, ["rev-parse", "--verify", `refs/heads/${shortName}`]);
    return true;
  } catch {
    return false;
  }
}

function allocateBranchName(repoDir: string, backlog: Backlog): string {
  const id = backlog.backlogDocumentId!.trim();
  const slug = branchBaseName(backlog);
  let candidate = `backlog/${id}-${slug}`;
  if (candidate.length > MAX_BRANCH_TOTAL) {
    const maxSlug = Math.max(8, MAX_BRANCH_TOTAL - `backlog/${id}-`.length);
    candidate = `backlog/${id}-${slug.slice(0, maxSlug)}`;
  }
  if (!localBranchExists(repoDir, candidate)) return candidate;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const base = `backlog/${id}-${slug}`.slice(0, MAX_BRANCH_TOTAL - suffix.length);
    const tryName = `${base}${suffix}`;
    if (!localBranchExists(repoDir, tryName)) return tryName;
  }
  return `backlog/${id}-${slug}-${Date.now().toString(36)}`;
}

function mergeRunContextBranch(session: OrchestratorSession, branchName: string): void {
  if (!session.activeProjectSlug || !session.activeProject) return;
  const lastRunDir = resolveLastRunDir(session);
  const treeUrl = buildGitHubTreeUrlForProject(session.activeProject, branchName);
  if (!treeUrl) return;
  const previous = loadLastRunContext(lastRunDir);
  const next = {
    updatedAt: new Date().toISOString(),
    projectSlug: session.activeProjectSlug,
    latestByRole: previous?.latestByRole ?? {},
    latestBranchUrl: treeUrl,
  };
  writeFileSync(resolve(lastRunDir, LAST_RUN_CONTEXT_FILE), JSON.stringify(next, null, 2), "utf-8");
}

/**
 * Checkout `project.branch` puis crée et suit une branche `backlog/<documentId>-<slug>` dans `local_path`.
 * No-op sans `local_path`. Met `session.backlogWorkBranch` et actualise `run-context.json` (URL arbre).
 */
export async function ensureBacklogWorkBranch(session: OrchestratorSession, backlog: Backlog): Promise<void> {
  const localPath = session.activeProject?.localPath?.trim();
  if (!localPath || !backlog.backlogDocumentId) return;

  const repoDir = resolve(localPath);
  if (!existsSync(repoDir)) {
    console.warn(`   ⚠️  Branche backlog : répertoire local introuvable : ${repoDir}`);
    return;
  }

  let isGit = false;
  try {
    isGit = runGit(repoDir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    isGit = false;
  }
  if (!isGit) {
    console.warn("   ⚠️  Branche backlog : pas de dépôt Git dans local_path — ignoré.");
    return;
  }

  const baseBranch = session.activeProject!.branch?.trim();
  if (!baseBranch) {
    console.warn("   ⚠️  Branche backlog : champ branch: du projet vide — ignoré.");
    return;
  }

  try {
    runGit(repoDir, ["fetch", "--prune", "origin"]);
  } catch {
    /* fetch optionnel */
  }

  try {
    runGit(repoDir, ["checkout", baseBranch]);
  } catch (e) {
    throw new Error(
      `Branche backlog : impossible de checkout la branche de base « ${baseBranch} » dans ${repoDir} : ${formatErrorMessage(e)}`,
    );
  }

  const branchName = allocateBranchName(repoDir, backlog);
  try {
    runGit(repoDir, ["checkout", "-b", branchName]);
  } catch (e) {
    throw new Error(`Branche backlog : impossible de créer « ${branchName} » : ${formatErrorMessage(e)}`);
  }

  session.backlogWorkBranch = branchName;
  mergeRunContextBranch(session, branchName);
  console.log(`   🌿 Branche de travail backlog : ${branchName} (depuis ${baseBranch})`);
}
