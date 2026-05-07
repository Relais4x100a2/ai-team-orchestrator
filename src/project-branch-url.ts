/**
 * Construction d’URL GitHub `.../tree/<branche>` et détection des branches « trunk »
 * pour le réalignement de last-run/run-context.json après merge manuel vers main.
 */

import type { ProjectContext } from "./models.js";

const DEFAULT_TRUNK_BRANCHES = ["main", "master", "trunk"] as const;

/** Branche extraite d’une URL …/tree/&lt;branch&gt;… (GitHub). */
export function extractBranchNameFromGitHubTreeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/tree\/([^?#\s]+)/i);
  if (!match?.[1]) return undefined;
  return decodeURIComponent(match[1]);
}

/**
 * Liste des noms de branches d’intégration (insensible à la casse).
 * Surcharge : CSV dans `BRANCH_MISMATCH_TRUNK_BRANCHES`.
 */
export function resolveTrunkBranchNames(): string[] {
  const raw = process.env.BRANCH_MISMATCH_TRUNK_BRANCHES?.trim();
  if (!raw) return [...DEFAULT_TRUNK_BRANCHES];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isTrunkBranch(branch: string): boolean {
  const b = branch.trim().toLowerCase();
  return resolveTrunkBranchNames().includes(b);
}

/** URL canonique `https://github.com/owner/repo/tree/branch` si le frontmatter est exploitable. */
export function buildGitHubTreeUrlForProject(project: ProjectContext): string | undefined {
  const branch = project.branch?.trim();
  const repoRaw = project.repo?.trim();
  if (!branch || !repoRaw) return undefined;

  let base = repoRaw.replace(/\.git$/i, "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) {
    if (/^[\w.-]+\/[\w.-]+$/i.test(base)) {
      base = `https://github.com/${base}`;
    } else {
      return undefined;
    }
  }

  let pathname: string;
  try {
    const u = new URL(base);
    if (!/(\.|^)github\.com$/i.test(u.hostname)) {
      return undefined;
    }
    pathname = u.pathname.replace(/\/$/, "");
  } catch {
    return undefined;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const [owner, repoName] = segments;
  return `https://github.com/${owner}/${repoName}/tree/${encodeURIComponent(branch)}`;
}
