import { existsSync, readFileSync } from "fs";
import matter from "gray-matter";
import { isAbsolute, resolve } from "path";
import type { ProjectContext } from "../models.js";
import { assertValidProjectContext } from "../models.js";
import { formatErrorMessage, resolveUserPath } from "./paths-and-env.js";

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
  const rawLocalPath = typeof data.local_path === "string" ? data.local_path.trim() : "";
  const resolvedLocalPath = rawLocalPath
    ? isAbsolute(rawLocalPath)
      ? rawLocalPath
      : resolve(process.env.HOME ?? "", rawLocalPath.replace(/^~\//, ""))
    : undefined;
  const project: ProjectContext = {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Projet sans nom",
    repo: typeof data.repo === "string" && data.repo.trim() ? data.repo.trim() : (process.env.TARGET_REPO_URL ?? "").trim(),
    branch:
      typeof data.branch === "string" && data.branch.trim()
        ? data.branch.trim()
        : (process.env.TARGET_BRANCH ?? "main").trim() || "main",
    content: parsed.content.trim(),
    localPath: resolvedLocalPath,
  };
  assertValidProjectContext(project, absolutePath);
  return project;
}
