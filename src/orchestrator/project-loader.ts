import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import matter from "gray-matter";
import { isAbsolute, resolve } from "path";
import type { ProjectContext } from "../models.js";
import { assertValidProjectContext } from "../models.js";
import {
  assertFileUnderDir,
  assertSafeRelativeProjectPath,
  assertSubpath,
  formatDataDirPath,
  formatErrorMessage,
  LAST_RUN_BASE_DIR,
  resolveProjectLocalPath,
  resolveUserPath,
} from "./paths-and-env.js";
import { LAST_RUN_CONTEXT_FILE } from "./run-context.js";

const DEFAULT_PROJECT_DATA_DIR = ".ai-team-orchestrator";
const DEFAULT_CONTEXT_FILENAME = "context.md";

function readFileUtf8(path: string, label: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`Impossible de lire ${label} (${formatDataDirPath(path)}) : ${formatErrorMessage(e)}`);
  }
}

/** Avertit si d’anciennes données existent encore sous last-run/<slug>/ alors que le projet utilise projectDataDir. */
export function warnIfLegacyLastRunDataExists(projectSlug: string | null, projectDataDir: string | undefined): void {
  if (!projectSlug || !projectDataDir) return;
  const legacyDir = resolve(LAST_RUN_BASE_DIR, projectSlug);
  if (!existsSync(legacyDir)) return;
  const markers = ["backlog.json", LAST_RUN_CONTEXT_FILE, "pm.md"];
  let hasNonEmpty = false;
  for (const name of markers) {
    const p = resolve(legacyDir, name);
    if (existsSync(p)) {
      try {
        if (statSync(p).size > 0) hasNonEmpty = true;
      } catch {
        /* ignore */
      }
    }
  }
  if (!hasNonEmpty) return;
  console.warn(
    `⚠️  Données legacy détectées sous last-run/${projectSlug}/.\n` +
      `   Le projet utilise désormais ${formatDataDirPath(projectDataDir)}.\n` +
      "   Copie suggérée :\n" +
      `     cp -a ${formatDataDirPath(legacyDir)}/. ${formatDataDirPath(projectDataDir)}/\n` +
      "   Sinon le backlog et la mémoire de branche/PR repartent de zéro.",
  );
}

function resolveProjectContent(
  data: Record<string, unknown>,
  displayPath: string,
  projectDataDir: string,
  fallbackBody: string,
): { content: string; projectContextPath?: string } {
  const hasExplicitContextKey = Object.prototype.hasOwnProperty.call(data, "project_context");
  const rawContext = hasExplicitContextKey ? data.project_context : undefined;

  if (hasExplicitContextKey) {
    if (rawContext === null || rawContext === undefined) {
      throw new Error(
        `Frontmatter "project_context" dans ${displayPath} : une valeur chaîne est requise si la clé est présente.`,
      );
    }
    if (typeof rawContext !== "string") {
      throw new Error(`Frontmatter "project_context" invalide dans ${displayPath} : chaîne attendue.`);
    }
    const rel = rawContext.trim();
    if (!rel) {
      throw new Error(`Frontmatter "project_context" dans ${displayPath} : chaîne non vide obligatoire.`);
    }
    assertSafeRelativeProjectPath(rel, `project_context dans ${displayPath}`);
    const contextAbs = resolve(projectDataDir, rel);
    assertFileUnderDir(projectDataDir, contextAbs);
    const content = readFileUtf8(contextAbs, "project_context");
    return { content: content.trim(), projectContextPath: contextAbs };
  }

  const defaultCtx = resolve(projectDataDir, DEFAULT_CONTEXT_FILENAME);
  if (existsSync(defaultCtx)) {
    try {
      const content = readFileSync(defaultCtx, "utf-8").trim();
      return { content, projectContextPath: defaultCtx };
    } catch (e) {
      throw new Error(
        `Impossible de lire le fichier de contexte par défaut (${formatDataDirPath(defaultCtx)}) : ${formatErrorMessage(e)}`,
      );
    }
  }

  return { content: fallbackBody };
}

export function loadProject(filePath: string): ProjectContext {
  const { absolutePath, displayPath } = resolveUserPath(filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Projet introuvable : ${displayPath}`);
  }
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf-8");
  } catch (e) {
    throw new Error(`Impossible de lire le projet ${displayPath} : ${formatErrorMessage(e)}`);
  }
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (e) {
    throw new Error(`Frontmatter invalide dans ${displayPath} : ${formatErrorMessage(e)}`);
  }
  const data = parsed.data as Record<string, unknown>;
  if (data.name !== undefined && typeof data.name !== "string") {
    throw new Error(`Frontmatter "name" invalide dans ${displayPath} : chaîne attendue.`);
  }
  if (data.repo !== undefined && typeof data.repo !== "string") {
    throw new Error(`Frontmatter "repo" invalide dans ${displayPath} : chaîne attendue.`);
  }
  if (data.branch !== undefined && typeof data.branch !== "string") {
    throw new Error(`Frontmatter "branch" invalide dans ${displayPath} : chaîne attendue.`);
  }
  if (data.local_path !== undefined && typeof data.local_path !== "string") {
    throw new Error(`Frontmatter "local_path" invalide dans ${displayPath} : chaîne attendue.`);
  }
  if (data.project_data_dir !== undefined && typeof data.project_data_dir !== "string") {
    throw new Error(`Frontmatter "project_data_dir" invalide dans ${displayPath} : chaîne attendue.`);
  }

  const hasDataDirKey = Object.prototype.hasOwnProperty.call(data, "project_data_dir");
  const hasContextKey = Object.prototype.hasOwnProperty.call(data, "project_context");

  const rawLocalPath = typeof data.local_path === "string" ? data.local_path.trim() : "";
  if (!rawLocalPath && (hasDataDirKey || hasContextKey)) {
    throw new Error(
      `« project_data_dir » / « project_context » dans ${displayPath} n’ont de sens qu’avec une clé « local_path » non vide.`,
    );
  }

  let resolvedLocalPath: string | undefined;
  if (rawLocalPath) {
    resolvedLocalPath = resolveProjectLocalPath(rawLocalPath);
    if (!existsSync(resolvedLocalPath)) {
      throw new Error(
        `local_path (${formatDataDirPath(resolvedLocalPath)}) introuvable pour le projet ${displayPath}.`,
      );
    }
  }

  let projectDataDir: string | undefined;
  let projectContextPath: string | undefined;
  let content: string;

  const fallbackBody = parsed.content.trim();

  if (resolvedLocalPath) {
    let relDataDir = DEFAULT_PROJECT_DATA_DIR;
    if (hasDataDirKey) {
      const pdd = typeof data.project_data_dir === "string" ? data.project_data_dir.trim() : "";
      if (!pdd) {
        throw new Error(`Frontmatter "project_data_dir" dans ${displayPath} : chaîne non vide obligatoire si la clé est présente.`);
      }
      assertSafeRelativeProjectPath(pdd, `project_data_dir dans ${displayPath}`);
      relDataDir = pdd;
    }
    projectDataDir = resolve(resolvedLocalPath, relDataDir);
    mkdirSync(projectDataDir, { recursive: true });
    assertSubpath(resolvedLocalPath, projectDataDir);

    const resolved = resolveProjectContent(data, displayPath, projectDataDir, fallbackBody);
    content = resolved.content;
    projectContextPath = resolved.projectContextPath;
  } else {
    content = fallbackBody;
  }

  const project: ProjectContext = {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Projet sans nom",
    repo: typeof data.repo === "string" && data.repo.trim() ? data.repo.trim() : (process.env.TARGET_REPO_URL ?? "").trim(),
    branch:
      typeof data.branch === "string" && data.branch.trim()
        ? data.branch.trim()
        : (process.env.TARGET_BRANCH ?? "main").trim() || "main",
    content,
    localPath: resolvedLocalPath,
    projectDataDir,
    projectContextPath,
  };
  assertValidProjectContext(project, absolutePath);
  return project;
}
