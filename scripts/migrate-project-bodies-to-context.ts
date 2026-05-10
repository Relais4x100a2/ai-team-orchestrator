/**
 * Copie le corps markdown de chaque projects/<slug>.md vers
 * <local_path>/<project_data_dir>/context.md (défaut .ai-team-orchestrator),
 * puis réduit le fichier projet au seul frontmatter.
 * Ignore les fichiers sans local_path (ex. orchestrateur seul).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import matter from "gray-matter";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import {
  assertSubpath,
  assertSafeRelativeProjectPath,
  resolveProjectLocalPath,
  formatDataDirPath,
} from "../src/orchestrator/paths-and-env.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");
const PROJECTS_DIR = join(REPO_ROOT, "projects");
const DEFAULT_DATA_DIR = ".ai-team-orchestrator";

function main(): void {
  const names = readdirSync(PROJECTS_DIR).filter((f) => f.endsWith(".md") && f !== "_template.md");
  if (names.length === 0) {
    console.log("Aucun fichier projects/*.md à traiter (hors _template.md).");
    return;
  }
  for (const name of names) {
    const projectPath = join(PROJECTS_DIR, name);
    let raw: string;
    try {
      raw = readFileSync(projectPath, "utf-8");
    } catch (e) {
      console.error(`❌ ${name} : lecture impossible : ${e}`);
      continue;
    }
    let parsed: ReturnType<typeof matter>;
    try {
      parsed = matter(raw);
    } catch (e) {
      console.error(`❌ ${name} : frontmatter invalide : ${e}`);
      continue;
    }
    const data = parsed.data as Record<string, unknown>;
    const localPathRaw = typeof data.local_path === "string" ? data.local_path.trim() : "";
    if (!localPathRaw) {
      console.log(`ℹ️  Skip ${name} : pas de local_path (détail conservé dans projects/).`);
      continue;
    }
    let localPath: string;
    try {
      localPath = resolveProjectLocalPath(localPathRaw);
    } catch (e) {
      console.error(`❌ ${name} : ${(e as Error).message}`);
      continue;
    }
    if (!existsSync(localPath)) {
      console.error(`❌ ${name} : local_path introuvable : ${formatDataDirPath(localPath)}`);
      continue;
    }
    let relDataDir = DEFAULT_DATA_DIR;
    if (Object.prototype.hasOwnProperty.call(data, "project_data_dir")) {
      const pdd = data.project_data_dir;
      if (typeof pdd !== "string" || !pdd.trim()) {
        console.error(`❌ ${name} : project_data_dir doit être une chaîne non vide si la clé est présente.`);
        continue;
      }
      try {
        assertSafeRelativeProjectPath(pdd.trim(), `project_data_dir (${name})`);
      } catch (e) {
        console.error(`❌ ${name} : ${(e as Error).message}`);
        continue;
      }
      relDataDir = pdd.trim();
    }
    const projectDataDir = resolve(localPath, relDataDir);
    mkdirSync(projectDataDir, { recursive: true });
    try {
      assertSubpath(localPath, projectDataDir);
    } catch (e) {
      console.error(`❌ ${name} : ${(e as Error).message}`);
      continue;
    }
    const contextPath = join(projectDataDir, "context.md");
    const body = parsed.content.trim();
    if (existsSync(contextPath) && body.length > 0) {
      console.warn(
        `⚠️  ${name} : ${formatDataDirPath(contextPath)} existe déjà — contenu remplacé par le corps de projects/.`,
      );
    }
    writeFileSync(contextPath, body ? `${body}\n` : "", "utf-8");
    const out = matter.stringify("", data);
    writeFileSync(projectPath, out.endsWith("\n") ? out : `${out}\n`, "utf-8");
    console.log(`✅ ${name} → ${formatDataDirPath(contextPath)} (frontmatter seul dans projects/${name})`);
  }
}

main();
