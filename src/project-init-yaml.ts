import { existsSync, readFileSync, writeFileSync } from "fs";
import matter from "gray-matter";
import { basename, extname, isAbsolute, join, resolve } from "path";
import { extractOwnerRepo } from "./github-sync.js";
import { resolveProjectLocalPath } from "./orchestrator/paths-and-env.js";

const REQUIRED_KEYS = ["name", "repo", "branch", "local_path"] as const;

export type ProjectYamlManifest = {
  name: string;
  repo: string;
  branch: string;
  local_path: string;
};

export function parseProjectYamlManifest(raw: string): ProjectYamlManifest {
  const data: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error(`Ligne YAML invalide (attendu « clé: valeur ») : ${trimmed}`);
    }
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) throw new Error(`Clé YAML vide : ${trimmed}`);
    data[key] = value;
  }

  const manifest: Partial<ProjectYamlManifest> = {};
  for (const key of REQUIRED_KEYS) {
    const value = data[key]?.trim();
    if (!value) {
      throw new Error(`Manifeste projet : clé obligatoire « ${key} » manquante ou vide.`);
    }
    manifest[key] = value;
  }

  return manifest as ProjectYamlManifest;
}

/** Accepte une URL GitHub ou un identifiant « owner/repo ». */
export function normalizeProjectRepoUrl(raw: string): string {
  const t = raw.trim();
  if (!t) throw new Error("repo vide.");
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) {
    return `https://github.com/${t}`;
  }
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, "")}`;
  extractOwnerRepo(withScheme);
  return withScheme.replace(/\.git$/i, "");
}

export function projectSlugFromManifestPath(manifestPath: string): string {
  const base = basename(manifestPath);
  const stem = base.endsWith(".project.yaml")
    ? base.slice(0, -".project.yaml".length)
    : extname(base)
      ? basename(base, extname(base))
      : base;
  const slug = stem.trim();
  if (!slug || slug === "_template") {
    throw new Error(`Nom de slug invalide dérivé du manifeste : ${manifestPath}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)) {
    throw new Error(
      `Slug projet invalide « ${slug} » (utilisez lettres, chiffres, « - », « _ » ou « . »).`,
    );
  }
  return slug;
}

export function buildProjectMarkdownFromTemplate(
  templateMarkdown: string,
  manifest: ProjectYamlManifest,
): string {
  const parsed = matter(templateMarkdown);
  const repo = normalizeProjectRepoUrl(manifest.repo);
  const frontmatter = {
    name: manifest.name.trim(),
    repo,
    branch: manifest.branch.trim(),
    local_path: manifest.local_path.trim(),
  };
  const body = parsed.content.replace(/^\n+/, "");
  return matter.stringify(body, frontmatter);
}

export function resolveProjectManifestPath(repoRoot: string, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Chemin de manifeste vide.");
  const candidates: string[] = [];
  if (trimmed.endsWith(".yaml") || trimmed.endsWith(".yml")) {
    candidates.push(isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed));
  } else {
    const slug = trimmed.replace(/\.md$/i, "");
    candidates.push(resolve(repoRoot, "projects", `${slug}.yaml`));
    candidates.push(resolve(repoRoot, "projects", `${slug}.project.yaml`));
    candidates.push(resolve(process.cwd(), `${slug}.yaml`));
    candidates.push(resolve(process.cwd(), `${slug}.project.yaml`));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Manifeste introuvable pour « ${input} » (essayé : ${candidates.map((c) => `"${c}"`).join(", ")}).`,
  );
}

export type InitProjectFromYamlOptions = {
  repoRoot: string;
  manifestPath: string;
  force?: boolean;
  checkLocalPath?: boolean;
};

export type InitProjectFromYamlResult = {
  slug: string;
  manifestPath: string;
  outputPath: string;
};

export function initProjectFromYamlManifest(options: InitProjectFromYamlOptions): InitProjectFromYamlResult {
  const manifestPath = resolve(options.manifestPath);
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifeste introuvable : ${manifestPath}`);
  }

  const slug = projectSlugFromManifestPath(manifestPath);
  const templatePath = join(options.repoRoot, "projects", "_template.md");
  if (!existsSync(templatePath)) {
    throw new Error(`Template projet introuvable : ${templatePath}`);
  }

  const outputPath = join(options.repoRoot, "projects", `${slug}.md`);
  if (existsSync(outputPath) && !options.force) {
    throw new Error(`Fichier projet déjà présent : ${outputPath} (utilisez --force pour écraser).`);
  }

  const manifest = parseProjectYamlManifest(readFileSync(manifestPath, "utf-8"));
  normalizeProjectRepoUrl(manifest.repo);

  if (options.checkLocalPath !== false) {
    const localPath = resolveProjectLocalPath(manifest.local_path);
    if (!existsSync(localPath)) {
      throw new Error(`local_path introuvable : ${localPath}`);
    }
  }

  const templateMarkdown = readFileSync(templatePath, "utf-8");
  const markdown = buildProjectMarkdownFromTemplate(templateMarkdown, manifest);
  writeFileSync(outputPath, markdown, "utf-8");

  return { slug, manifestPath, outputPath };
}
