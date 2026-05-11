import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, normalize, relative, resolve } from "path";
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

/** Tronque un contexte markdown en préservant la structure (retours à la ligne). */
export function trimContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[…tronqué]";
}

/** Extrait une section Handoff depuis la fin d'un texte agent. Retourne "" si le marqueur est absent. */
export function extractHandoffSection(text: string, marker: string): string {
  const idx = text.indexOf(marker);
  return idx >= 0 ? text.slice(idx).trim() : "";
}

/**
 * Avertit en console si la sortie agent est non vide mais ne contient pas le marqueur de handoff attendu
 * (les étapes aval utiliseront alors un extrait ou une troncature).
 */
export function warnIfHandoffFallback(stepLabel: string, fullText: string, marker: string, extracted: string): void {
  if (!fullText.trim() || extracted.trim()) return;
  console.warn(
    `⚠️  ${stepLabel} : marqueur «${marker}» absent — extrait ou troncature utilisé(e) pour les étapes suivantes.`,
  );
}

const DEFAULT_MIN_DEV_OUTPUT_CHARS = 80;

/**
 * Indique si la sortie développeur est trop pauvre pour enchaîner sécurité / QA sans risquer un audit ou une revue sur une section « implémentation » vide.
 * Contre-exemples : texte assez long, handoff «## Handoff Security & QA» présent, ou PR connue (passée par l’appelant).
 */
export function isDevPipelineOutputTooWeak(
  text: string,
  options?: { prUrl?: string | undefined; minTrimmedChars?: number },
): boolean {
  const raw = text.trim();
  if (raw.length === 0) return true;

  const minTrimmed = options?.minTrimmedChars ?? DEFAULT_MIN_DEV_OUTPUT_CHARS;
  if (raw.length >= minTrimmed) return false;

  const pr = options?.prUrl?.trim();
  if (pr) return false;

  const handoff = extractHandoffSection(text, "## Handoff Security & QA").trim();
  if (handoff.length > 0) return false;

  return true;
}

export function resolveUserPath(inputPath: string): { absolutePath: string; displayPath: string } {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Chemin vide.");
  const absolutePath = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  const rel = relative(process.cwd(), absolutePath);
  const isInside = !rel.startsWith("..") && !isAbsolute(rel);
  return { absolutePath, displayPath: isInside ? rel || "." : absolutePath };
}

/** Développe `~/` ou `~` avec `os.homedir()` (plus fiable que `HOME` seul). */
export function expandHomePath(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("~/")) {
    const home = homedir();
    if (!home) throw new Error('Impossible de développer "~/" : répertoire personnel indisponible.');
    return resolve(home, t.slice(2));
  }
  if (t === "~") {
    const home = homedir();
    if (!home) throw new Error('Impossible de développer "~" : répertoire personnel indisponible.');
    return home;
  }
  return t;
}

/**
 * Résout la valeur frontmatter `local_path` : absolu inchangé, `~/` développé, sinon relatif au cwd.
 */
export function resolveProjectLocalPath(raw: string): string {
  const t = raw.trim();
  if (!t) throw new Error("Chemin local (`local_path`) vide.");
  if (isAbsolute(t)) return normalize(t);
  if (t.startsWith("~/") || t === "~") return normalize(expandHomePath(t));
  return normalize(resolve(process.cwd(), t));
}

const WIN_DRIVE = /^[A-Za-z]:[\\/]/;

/** Rejette les chemins de données hors arborescence attendue (`..`, absolu). */
export function assertSafeRelativeProjectPath(relativePath: string, label: string): void {
  const t = relativePath.trim();
  if (!t) throw new Error(`${label} ne peut pas être vide.`);
  if (isAbsolute(t) || WIN_DRIVE.test(t)) {
    throw new Error(`${label} doit être relatif (chemin absolu interdit).`);
  }
  // Ne pas utiliser normalize() avant la détection : sinon « a/../b » se replie en « b ».
  const segments = t.split(/[/\\]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(`${label} ne doit pas contenir de segment « .. ».`);
    }
  }
}

/**
 * Vérifie que `childPath` est situé sous `parentDir` (après realpath).
 * Crée `childPath` si absent pour permettre la vérification des symlinks.
 */
export function assertSubpath(parentDir: string, childPath: string): void {
  mkdirSync(childPath, { recursive: true });
  let parentReal: string;
  let childReal: string;
  try {
    parentReal = realpathSync(parentDir);
    childReal = realpathSync(childPath);
  } catch {
    throw new Error(`Impossible de résoudre les chemins (répertoire projet ou données).`);
  }
  const rel = relative(parentReal, childReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Le répertoire de données doit rester sous le dépôt local ; lien ou chemin invalide détecté : ${childReal}`,
    );
  }
}

/** Vérifie qu’un fichier résolu reste sous `rootDir` (après création des parents). */
export function assertFileUnderDir(rootDir: string, filePath: string): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  assertSubpath(rootDir, parent);
}

/** Affichage terminal : chemin relatif au cwd si possible, sinon absolu. */
export function formatDataDirPath(fileOrDirPath: string): string {
  const abs = normalize(fileOrDirPath);
  const rel = relative(process.cwd(), abs);
  return !rel.startsWith("..") && !isAbsolute(rel) ? rel || "." : abs;
}

const DATA_DIR_GITIGNORE = "*\n!.gitignore\n";

/**
 * Crée le répertoire si besoin ; à la première création uniquement, ajoute un `.gitignore` minimal s’il n’existe pas.
 */
export function mkdirWithDefaultGitignoreIfNeeded(lastRunDir: string): void {
  const wasNew = !existsSync(lastRunDir);
  mkdirSync(lastRunDir, { recursive: true });
  const gitignorePath = resolve(lastRunDir, ".gitignore");
  if (wasNew && !existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, DATA_DIR_GITIGNORE, "utf-8");
  }
}

export function setupRipgrepPath(): void {
  const rgPath = resolve(REPO_ROOT, "node_modules/ripgrep/lib/rg.mjs");
  if (existsSync(rgPath) && !process.env.RG_PATH) {
    process.env.RG_PATH = rgPath;
  }
}
