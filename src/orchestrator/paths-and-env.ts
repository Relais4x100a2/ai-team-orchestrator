import { existsSync } from "fs";
import { dirname, resolve, isAbsolute, relative } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
/** Répertoire `src/` (parent de `orchestrator/`). */
export const SRC_DIR = resolve(here, "..");
export const REPO_ROOT = resolve(SRC_DIR, "..");
export const LAST_RUN_BASE_DIR = resolve(REPO_ROOT, "last-run");
export const BACKLOG_FALLBACK_PATH = resolve(REPO_ROOT, "backlog.json");

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function previewText(text: string, maxLength = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

export function resolveUserPath(inputPath: string): { absolutePath: string; displayPath: string } {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Chemin vide.");
  const absolutePath = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  const rel = relative(process.cwd(), absolutePath);
  const isInside = !rel.startsWith("..") && !isAbsolute(rel);
  return { absolutePath, displayPath: isInside ? rel || "." : absolutePath };
}

export function setupRipgrepPath(): void {
  const rgPath = resolve(REPO_ROOT, "node_modules/ripgrep/lib/rg.mjs");
  if (existsSync(rgPath) && !process.env.RG_PATH) {
    process.env.RG_PATH = rgPath;
  }
}
