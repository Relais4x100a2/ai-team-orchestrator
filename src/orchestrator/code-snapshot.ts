import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";

const SNAPSHOT_MAX_CHARS = 2000;

function trimSnapshot(text: string): string {
  if (text.length <= SNAPSHOT_MAX_CHARS) return text;
  return text.slice(0, SNAPSHOT_MAX_CHARS) + "\n\n[…tronqué]";
}

/** Retourne true si context.md est plus vieux que le dernier commit git dans localPath. */
function isContextStale(contextPath: string, localPath: string): boolean {
  try {
    const contextMtime = statSync(contextPath).mtimeMs;
    const lastCommitTs = tryExec("git", ["log", "-1", "--format=%ct"], localPath);
    if (!lastCommitTs) return false;
    return parseInt(lastCommitTs, 10) * 1000 > contextMtime;
  } catch {
    return false;
  }
}

function tryExec(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

/**
 * Construit un snapshot léger du code pour l'injecter en contexte agent.
 * Priorité : context.md dans projectDataDir. Fallback : git log + diff stat + arbre.
 */
export function buildCodeSnapshot(localPath: string, projectDataDir?: string): string {
  if (projectDataDir) {
    const contextPath = resolve(projectDataDir, "context.md");
    if (existsSync(contextPath)) {
      const content = readFileSync(contextPath, "utf-8").trim();
      if (content) {
        if (isContextStale(contextPath, localPath)) {
          console.warn("   ⚠️  context.md plus ancien que le dernier commit — snapshot git utilisé.");
        } else {
          return trimSnapshot(`## Contexte code (context.md)\n\n${content}`);
        }
      }
    }
  }

  const parts: string[] = ["## Snapshot code"];

  const log = tryExec("git", ["log", "--oneline", "-7"], localPath);
  if (log) parts.push(`### Commits récents\n\`\`\`\n${log}\n\`\`\``);

  const stat = tryExec("git", ["diff", "--stat", "HEAD~3"], localPath);
  if (stat) parts.push(`### Fichiers récemment modifiés\n\`\`\`\n${stat}\n\`\`\``);

  const tree = tryExec(
    "find",
    [
      ".",
      "-maxdepth",
      "2",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/dist/*",
    ],
    localPath,
  );
  if (tree) parts.push(`### Structure (2 niveaux)\n\`\`\`\n${tree}\n\`\`\``);

  return trimSnapshot(parts.join("\n\n"));
}
