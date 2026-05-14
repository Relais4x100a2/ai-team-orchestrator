/**
 * Ferme sur GitHub les issues liées aux entrées backlog en statut `done`
 * (déjà fermées → no-op via closeGitHubIssueWithComment).
 *
 * Usage :
 *   npx tsx scripts/close-done-github-issues.ts --project dataset-style
 *   npx tsx scripts/close-done-github-issues.ts --project projects/dataset-style.md --dry-run
 *   npx tsx scripts/close-done-github-issues.ts --backlog /chemin/absolu/backlog.json --repo https://github.com/org/repo
 *
 * Prérequis : GITHUB_TOKEN dans .env (scope repo si dépôt privé).
 */
import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import { basename, resolve } from "path";
import { fileURLToPath } from "url";
import type { Backlog } from "../src/backlog.js";
import { closeGitHubIssueWithComment } from "../src/github-sync.js";
import { parseBacklogJson } from "../src/models.js";
import { loadBacklog } from "../src/orchestrator/backlog-io.js";
import { loadProject } from "../src/orchestrator/project-loader.js";
import { emptyOrchestratorSession } from "../src/orchestrator/session.js";
import type { OrchestratorSession } from "../src/orchestrator/session.js";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function normalizeProjectPath(arg: string): string {
  if (!arg.includes("/") && !arg.endsWith(".md")) {
    return resolve(REPO_ROOT, "projects", `${arg}.md`);
  }
  return resolve(REPO_ROOT, arg.startsWith("/") ? arg.slice(1) : arg);
}

function parseArgs(argv: string[]): {
  project?: string;
  backlogFile?: string;
  repo?: string;
  dryRun: boolean;
  help: boolean;
} {
  let project: string | undefined;
  let backlogFile: string | undefined;
  let repo: string | undefined;
  let dryRun = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--project" && argv[i + 1]) project = argv[++i]!;
    else if (a === "--backlog" && argv[i + 1]) backlogFile = argv[++i]!;
    else if (a === "--repo" && argv[i + 1]) repo = argv[++i]!;
  }
  return { project, backlogFile, repo, dryRun, help };
}

function commentForIssue(id: string): string {
  return [
    "Fermé via script `scripts/close-done-github-issues.ts` (backlog statut `done`).",
    `- Backlog id : \`${id}\``,
  ].join("\n");
}

function loadBacklogFromFile(absPath: string): Backlog {
  const p = resolve(absPath);
  if (!existsSync(p)) throw new Error(`Fichier introuvable : ${p}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    throw new Error(`JSON invalide : ${p}`);
  }
  return parseBacklogJson(parsed);
}

async function main(): Promise<void> {
  const { project, backlogFile, repo, dryRun, help } = parseArgs(process.argv.slice(2));

  if (help) {
    console.log(`Usage:
  npx tsx scripts/close-done-github-issues.ts --project <slug|chemin.md> [--dry-run]
  npx tsx scripts/close-done-github-issues.ts --backlog <backlog.json> --repo <https://github.com/owner/repo> [--dry-run]
`);
    process.exit(0);
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    console.error("❌ GITHUB_TOKEN manquante (.env à la racine de l’orchestrateur).");
    process.exit(1);
  }

  let repoUrl: string;
  let backlog: Backlog;

  if (project) {
    const projectPath = normalizeProjectPath(project);
    const session: OrchestratorSession = emptyOrchestratorSession();
    session.activeProject = loadProject(projectPath);
    session.activeProjectSlug =
      basename(projectPath, ".md")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || null;
    repoUrl = session.activeProject.repo?.trim() || "";
    if (!repoUrl) {
      console.error("❌ Pas de `repo:` dans le fichier projet.");
      process.exit(1);
    }
    backlog = loadBacklog(session);
    console.log(`📁 Projet : ${session.activeProject.name}`);
    console.log(`🔗 Repo    : ${repoUrl}\n`);
  } else if (backlogFile && repo) {
    repoUrl = repo.trim();
    backlog = loadBacklogFromFile(backlogFile);
    console.log(`📄 Backlog : ${resolve(backlogFile)}`);
    console.log(`🔗 Repo    : ${repoUrl}\n`);
  } else {
    console.error(
      "❌ Utilise `--project <slug>` ou `--backlog <fichier.json> --repo <url>`.",
    );
    process.exit(1);
  }

  const candidates = backlog.issues.filter(
    (i) =>
      i.status === "done" &&
      typeof i.githubIssueNumber === "number" &&
      Number.isFinite(i.githubIssueNumber),
  );

  if (candidates.length === 0) {
    console.log("✅ Aucune entrée `done` avec `githubIssueNumber`.");
    return;
  }

  console.log(`${candidates.length} entrée(s) à traiter :\n`);
  for (const i of candidates) {
    console.log(`   #${i.githubIssueNumber}  [${i.id}] ${i.title}`);
  }
  console.log("");

  if (dryRun) {
    console.log("🔍 --dry-run : aucun appel API.");
    return;
  }

  let ok = 0;
  for (const issue of candidates) {
    const num = issue.githubIssueNumber!;
    process.stdout.write(`   → #${num} … `);
    try {
      await closeGitHubIssueWithComment(repoUrl, token, num, commentForIssue(issue.id));
      console.log("ok");
      ok++;
    } catch (e) {
      console.log(`erreur : ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n✅ Fin (${ok}/${candidates.length} sans exception levée).`);
}

main().catch((e) => {
  console.error("❌", (e as Error).message);
  process.exit(1);
});