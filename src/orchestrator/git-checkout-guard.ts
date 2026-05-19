import { runGit } from "./git-sync.js";

export type GitRunner = (repoDir: string, args: string[], opts?: { quiet?: boolean }) => string;

/**
 * Retourne la liste des chemins à surveiller avant un checkout.
 * Lit ORCHESTRATOR_CHECKOUT_STASH_PATHS (virgules) ; défaut : ["backlog.json"].
 */
export function resolveCheckoutStashPaths(): string[] {
  const raw = process.env.ORCHESTRATOR_CHECKOUT_STASH_PATHS?.trim();
  if (!raw) return ["backlog.json"];
  const paths = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return paths.length > 0 ? paths : ["backlog.json"];
}

/**
 * Retourne les chemins de `candidates` qui sont modifiés (tracked) dans le
 * working tree ou l'index, et bloqueraient donc un `git checkout targetBranch`.
 */
export function findBlockingPaths(
  repoDir: string,
  _targetBranch: string,
  candidates: string[],
  git: GitRunner = runGit,
): string[] {
  if (candidates.length === 0) return [];

  const porcelain = git(repoDir, ["status", "--porcelain", "--untracked-files=no"]);
  const modified = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    modified.add(arrow >= 0 ? path.slice(arrow + 4) : path);
  }

  return candidates.filter((p) => modified.has(p));
}

/**
 * Met de côté (git stash) les chemins bloquants avant un checkout.
 * No-op si `paths` est vide.
 * Ne fait PAS de `stash pop` automatique après checkout.
 */
export function stashBlockingPaths(
  repoDir: string,
  paths: string[],
  git: GitRunner = runGit,
): void {
  if (paths.length === 0) return;
  git(repoDir, ["stash", "push", "-m", "ai-team-orchestrator: pre-checkout", "--", ...paths]);
  console.log(
    `   📦 Fichier(s) mis de côté avant checkout : ${paths.join(", ")}\n` +
      "   Pour restaurer après merge : git stash pop",
  );
}
