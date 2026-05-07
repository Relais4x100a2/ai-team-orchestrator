/**
 * ============================================================
 * AI Team Orchestrator — Cerveau de l'équipe de dev IA
 * ============================================================
 *
 * Ce script orchestre les agents du pipeline (PM, architecte, red team réflexion, dev, sécurité, QA)
 * et des rôles additionnels à la demande (voir AGENT_CONFIG).
 * via le Cursor SDK. Chaque agent est un subagent avec son propre prompt système
 * et potentiellement son propre modèle.
 *
 * Usage :
 *   npm run start              → Lance le menu interactif
 *   npm run agent:pm           → Lance uniquement l'agent PM
 *   npm run pipeline full      → Lance le pipeline complet sur une issue
 *
 * Tu n'as PAS besoin de modifier ce fichier au quotidien.
 * Les prompts des agents sont dans src/prompts/*.md — c'est là que tu ajustes.
 * ============================================================
 */

import "dotenv/config";
import { Agent } from "@cursor/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, basename, isAbsolute, relative } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";
import {
  createAgentConfig,
  formatModelSelection,
  PIPELINE_STEPS,
  resolveRunModel,
  type AgentRole,
  type PipelineStep,
} from "./agent-config.js";
import { checkFrugalMode } from "./spend-guard.js";
import { closeGitHubIssueWithComment, syncBacklogToGitHub } from "./github-sync.js";
import type { Backlog, BacklogIssue, IssuePriority, IssueSize, IssueStatus } from "./backlog.js";
import {
  generateIssueId,
  parsePMOutput,
  pickNextIssue,
} from "./backlog.js";
import { detectQAVerdict, detectSecurityVerdict } from "./pipeline-detection.js";
import { runCloudAgentWithPolicy } from "./cloud-policy.js";
import type { ProjectContext, PipelineRunStatus } from "./models.js";
import {
  assertValidProjectContext,
  newPipelineRunId,
  parseBacklogJson,
  resolveBriefFilePath,
} from "./models.js";
import { appendPipelineRun } from "./pipeline-runs.js";

// Configure ripgrep path for local agent operations
const __dirname = dirname(fileURLToPath(import.meta.url));
const rgPath = resolve(__dirname, "../node_modules/ripgrep/lib/rg.mjs");
if (existsSync(rgPath) && !process.env.RG_PATH) {
  process.env.RG_PATH = rgPath;
}


const BACKLOG_FALLBACK_PATH = resolve(__dirname, "../backlog.json");

function resolveBacklogPath(): string {
  if (activeProjectSlug) return resolve(resolveLastRunDir(), "backlog.json");
  return BACKLOG_FALLBACK_PATH;
}
let activeProject: ProjectContext | null = null;
let activeProjectSlug: string | null = null;

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewText(text: string, maxLength = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

/** Opt-in : `GITHUB_CLOSE_ISSUE_ON_PIPELINE_DONE=1|true|yes` */
function isGithubCloseIssueOnPipelineDoneEnabled(): boolean {
  const v = process.env.GITHUB_CLOSE_ISSUE_ON_PIPELINE_DONE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function githubPipelineCloseComment(issue: BacklogIssue): string {
  return [
    "Fermé automatiquement après `pipeline next` réussi (ai-team-orchestrator).",
    `- Backlog id : \`${issue.id}\``,
    `- pipelineRun : \`${issue.pipelineRun ?? "—"}\``,
  ].join("\n");
}

function resolveUserPath(inputPath: string): { absolutePath: string; displayPath: string } {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Chemin vide.");
  const absolutePath = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  const rel = relative(process.cwd(), absolutePath);
  const isInside = !rel.startsWith("..") && !isAbsolute(rel);
  return { absolutePath, displayPath: isInside ? (rel || ".") : absolutePath };
}

/** Charge un fichier prompt depuis src/prompts/ */
function loadPrompt(role: string): string {
  const path = resolve(__dirname, "prompts", `${role}.md`);
  if (!existsSync(path)) {
    throw new Error(`Prompt introuvable : ${path}`);
  }
  return readFileSync(path, "utf-8");
}

/** Charge un fichier projet depuis projects/ avec frontmatter YAML */
function loadProject(filePath: string): ProjectContext {
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
    ? (isAbsolute(rawLocalPath) ? rawLocalPath : resolve(process.env.HOME ?? "", rawLocalPath.replace(/^~\//, "")))
    : undefined;
  const project: ProjectContext = {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Projet sans nom",
    repo: typeof data.repo === "string" && data.repo.trim() ? data.repo.trim() : (process.env.TARGET_REPO_URL ?? "").trim(),
    branch: typeof data.branch === "string" && data.branch.trim() ? data.branch.trim() : (process.env.TARGET_BRANCH ?? "main").trim() || "main",
    content: parsed.content.trim(),
    localPath: resolvedLocalPath,
  };
  assertValidProjectContext(project, absolutePath);
  return project;
}

/** Configuration des agents — modèles via MODEL_STRONG / MODEL_FAST dans .env */
const AGENT_CONFIG = createAgentConfig();

const LAST_RUN_BASE_DIR = resolve(__dirname, "../last-run");

function resolveLastRunDir(): string {
  if (activeProjectSlug) return resolve(LAST_RUN_BASE_DIR, activeProjectSlug);
  return LAST_RUN_BASE_DIR;
}

/** URL du repo cible pour le mode cloud : projet actif ou .env */
function resolveRepoUrl(): string | undefined {
  const fromProject = activeProject?.repo?.trim();
  const fromEnv = process.env.TARGET_REPO_URL?.trim();
  const url = fromProject || fromEnv;
  return url || undefined;
}

function requireRepoUrlForCloud(cloud?: boolean): void {
  if (!cloud) return;
  if (!resolveRepoUrl()) {
    console.error(
      "❌ Mode cloud : un dépôt Git cible est obligatoire.\n" +
        "   Passe --project projects/<fichier>.md (frontmatter avec `repo:`)."
    );
    process.exit(1);
  }
}

// ------------------------------------------------------------
// Fonctions utilitaires
// ------------------------------------------------------------

/**
 * Crée et lance un agent avec le rôle spécifié.
 *
 * @param role - Le rôle de l'agent (pm, architect, dev, etc.)
 * @param task - La tâche à accomplir (le message envoyé à l'agent)
 * @param options - Options supplémentaires
 * @returns Le résultat de l'agent
 */
async function runAgent(
  role: AgentRole,
  task: string,
  options: {
    /** true = tourne dans le cloud Cursor, false = local */
    cloud?: boolean;
    /** true = crée automatiquement une PR à la fin */
    autoCreatePR?: boolean;
    /** Contexte additionnel à injecter (ex: résultat d'un agent précédent) */
    additionalContext?: string;
    /** true = forcer composer-2 (seuil de dépenses atteint) */
    frugal?: boolean;
    /** Taille d'issue backlog → grille modèles (rôles pipeline uniquement) */
    issueSize?: IssueSize;
  } = {}
) {
  const config = AGENT_CONFIG[role];
  const model = resolveRunModel(role, {
    issueSize: options.issueSize,
    frugal: Boolean(options.frugal),
    env: process.env,
  });
  const prompt = loadPrompt(config.promptFile);

  console.log(`\n🚀 Lancement de l'agent : ${config.description}`);
  if (options.frugal) {
    console.log(`   Modèle : ${formatModelSelection(model)} ⚠️ mode frugal`);
  } else {
    console.log(`   Modèle : ${formatModelSelection(model)}`);
  }
  console.log(`   Mode : ${options.cloud ? "☁️  Cloud" : "💻 Local"}`);
  console.log(`   Tâche : ${previewText(task)}`);
  console.log("─".repeat(60));

  // Construction du message avec le contexte
  const fullTask = options.additionalContext
    ? `## Contexte des étapes précédentes\n\n${options.additionalContext}\n\n---\n\n## Ta tâche\n\n${task}`
    : task;

  // Injection du contexte projet si disponible
  const projectSection = activeProject
    ? `\n\n---\n\n## Contexte du projet cible\n\n**Projet :** ${activeProject.name}\n**Repo :** ${activeProject.repo}\n**Branche :** ${activeProject.branch}${activeProject.localPath ? `\n**Chemin local :** ${activeProject.localPath}` : ""}\n\n${activeProject.content}`
    : "";

  requireRepoUrlForCloud(options.cloud);

  // Création de l'agent
  const agentOptions: Parameters<typeof Agent.create>[0] = {
    apiKey: process.env.CURSOR_API_KEY!,
    model,
  };

  // Mode cloud ou local
  const repoUrl = resolveRepoUrl();
  const branchRef = activeProject?.branch?.trim() || process.env.TARGET_BRANCH;

  if (options.cloud) {
    Object.assign(agentOptions, {
      cloud: {
        repos: [
          {
            url: repoUrl!,
            ...(branchRef && { startingRef: branchRef }),
          },
        ],
        autoCreatePR: options.autoCreatePR ?? false,
      },
    });
  } else {
    const localCwd = activeProject?.localPath ?? process.cwd();
    Object.assign(agentOptions, {
      local: { cwd: localCwd },
    });
    if (activeProject?.localPath) {
      console.log(`   Répertoire local : ${activeProject.localPath}`);
    }
  }

  const roleAndTask = `${prompt}\n\n---\n\n${fullTask}`;
  const taskWithSystemPrompt = projectSection ? `${projectSection}\n\n---\n\n${roleAndTask}` : roleAndTask;

  const runOnce = async () => {
    let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
    try {
      agent = await Agent.create(agentOptions);
    } catch (e) {
      throw new Error(`Impossible de créer l'agent ${role} (${model.id}) : ${formatErrorMessage(e)}`, { cause: e });
    }

    let run;
    try {
      run = await agent.send(taskWithSystemPrompt);
    } catch (e) {
      throw new Error(`Échec de l'envoi de la tâche à l'agent ${role} : ${formatErrorMessage(e)}`, { cause: e });
    }

    try {
      return await run.wait();
    } catch (e) {
      throw new Error(`L'agent ${role} n'a pas terminé correctement : ${formatErrorMessage(e)}`, { cause: e });
    } finally {
      // Évite l'accumulation de listeners AbortSignal entre runs successifs.
      try {
        const disposable = agent as { [Symbol.asyncDispose]?: () => Promise<void> } | null;
        const asyncDispose = disposable?.[Symbol.asyncDispose];
        if (typeof asyncDispose === "function") {
          await asyncDispose.call(disposable);
        } else if (agent && "close" in agent && typeof agent.close === "function") {
          agent.close();
        }
      } catch (disposeErr) {
        console.warn(`⚠️  Nettoyage agent (${role}) incomplet : ${formatErrorMessage(disposeErr)}`);
      }
    }
  };

  const runResult = options.cloud
    ? await runCloudAgentWithPolicy(runOnce, process.env, `⚠️  cloud-policy (${role}) :`)
    : await runOnce();

  if (runResult.result) {
    console.log(runResult.result);
  } else {
    console.log("(Pas de sortie retournée par l'agent)");
  }
  const result = runResult.result || "";

  // Auto-save output to last-run/<role>.md for reuse
  // Note: filename is fixed per role — lancer deux pipelines en parallèle
  // sur le même rôle s'écrase mutuellement (race condition intentionnellement
  // ignorée : outil local mono-utilisateur).
  if (result) {
    if (!activeProjectSlug) {
      console.log(`\n   ℹ️  Sortie non sauvegardée (pas de --project). Passe --project projects/<fichier>.md pour activer last-run/<slug>/${role}.md.`);
    } else {
      try {
        const lastRunDir = resolveLastRunDir();
        mkdirSync(lastRunDir, { recursive: true });
        writeFileSync(resolve(lastRunDir, `${role}.md`), result, "utf-8");
        console.log(`\n   💾 Sortie sauvegardée : last-run/${activeProjectSlug}/${role}.md`);
      } catch (e) {
        console.error(`   ⚠️  Impossible de sauvegarder la sortie last-run : ${(e as Error).message}`);
      }
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`✅ Agent ${role} terminé.\n`);

  return result;
}

function loadBacklog(): Backlog {
  if (!existsSync(resolveBacklogPath())) {
    return { version: 1, lastUpdated: new Date().toISOString(), issues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolveBacklogPath(), "utf-8"));
  } catch {
    throw new Error(
      "backlog.json : JSON invalide. Corrige le fichier ou supprime-le pour repartir d'un backlog vide."
    );
  }
  try {
    return parseBacklogJson(parsed);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(`backlog.json : ${msg}`);
  }
}

function saveBacklog(backlog: Backlog): void {
  backlog.lastUpdated = new Date().toISOString();
  const path = resolveBacklogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(backlog, null, 2), "utf-8");
}

function printBacklogSummary(backlog?: Backlog): void {
  const b = backlog ?? loadBacklog();
  const counts: Record<IssueStatus, number> = { todo: 0, in_progress: 0, done: 0, skipped: 0 };
  for (const i of b.issues) counts[i.status]++;

  console.log("\n" + "═".repeat(60));
  console.log("📦 BACKLOG — État actuel");
  console.log("═".repeat(60));
  console.log(`  Total : ${b.issues.length} issues`);
  console.log(`  Todo         : ${counts.todo}`);
  console.log(`  In progress  : ${counts.in_progress}`);
  console.log(`  Done         : ${counts.done}`);
  if (counts.skipped) console.log(`  Skipped      : ${counts.skipped}`);
  console.log("─".repeat(60));

  const statusIcon: Record<IssueStatus, string> = { todo: "⬜", in_progress: "🔄", done: "✅", skipped: "⏭️" };
  const priorities: IssuePriority[] = ["MUST", "SHOULD", "COULD", "WONT"];

  for (const priority of priorities) {
    const group = b.issues.filter(i => i.priority === priority);
    if (group.length === 0) continue;
    console.log(`\n  [${priority}]`);
    for (const issue of group) {
      const icon = statusIcon[issue.status];
      const size = issue.size.padEnd(2);
      console.log(`  ${icon} [${size}] ${issue.id}  ${issue.title}`);
    }
  }

  console.log("\n" + "═".repeat(60));
  if (b.lastUpdated) {
    console.log(`  Dernière mise à jour : ${new Date(b.lastUpdated).toLocaleString("fr-FR")}`);
  }
}

// Workflow : PM backlog analysis
async function pmBacklogWorkflow() {
  console.log("═".repeat(60));
  console.log("📋 PM BACKLOG — Analyse du repo et génération du backlog");
  console.log("═".repeat(60));

  const repoUrl = resolveRepoUrl();
  if (!repoUrl) {
    console.error(
      "❌ PM backlog (mode cloud) : dépôt cible inconnu.\n" +
        "   Utilise --project projects/<fichier>.md (frontmatter avec `repo:`)."
    );
    process.exit(1);
  }

  const pmTask = `Analyse le repo ${repoUrl} et produis la liste complète des issues prioritaires à implémenter. Pour CHAQUE issue, utilise EXACTEMENT le format défini (## 🎯 User Story, ## 🏷️ Priorité, ## 📏 Taille estimée, etc.). Sépare chaque issue par une ligne "---".`;

  const pmOutput = await runAgent("pm", pmTask, { cloud: true });
  const parsedIssues = parsePMOutput(pmOutput);

  if (parsedIssues.length === 0) {
    console.log("⚠️  Aucune issue parsée depuis la sortie du PM. Vérifie le format de sortie.");
    console.log("   Sortie brute sauvegardée dans backlog-raw.md pour inspection.\n");
    writeFileSync(resolve(__dirname, "../backlog-raw.md"), pmOutput, "utf-8");
    return;
  }

  const backlog = loadBacklog();
  const now = new Date().toISOString();

  for (const parsed of parsedIssues) {
    const id = generateIssueId(backlog);
    backlog.issues.push({
      ...parsed,
      id,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      pipelineRun: null,
    });
    console.log(`   + ${id}: [${parsed.priority}/${parsed.size}] ${parsed.title}`);
  }

  saveBacklog(backlog);
  console.log(`\n✅ ${parsedIssues.length} issue(s) ajoutées à backlog.json`);
  printBacklogSummary(backlog);
}

// Workflow : Pipeline next
async function pipelineNext() {
  const backlog = loadBacklog();
  const issue = pickNextIssue(backlog);

  if (!issue) {
    console.log("🎉 Backlog vide — aucune issue à traiter (todo + non-WONT).");
    printBacklogSummary(backlog);
    return;
  }

  console.log(`\n▶ Issue sélectionnée : [${issue.id}] ${issue.title}`);
  console.log(`  Priorité: ${issue.priority} | Taille: ${issue.size}`);
  console.log("─".repeat(60));

  // Mark in_progress
  issue.status = "in_progress";
  issue.updatedAt = new Date().toISOString();
  const pipelineRunId = newPipelineRunId();
  issue.pipelineRun = pipelineRunId;
  saveBacklog(backlog);

  const issueRef = issue.githubIssueNumber
    ? `\n\nCette implémentation doit refermer l'issue GitHub #${issue.githubIssueNumber} — inclure \`close #${issue.githubIssueNumber}\` dans le message de commit ou la description de PR.`
    : "";
  try {
    const executionStartBySize: Record<IssueSize, PipelineStep> = {
      S: "dev",
      M: "architect",
      L: "architect",
      XL: "architect",
    };
    const executionStart = executionStartBySize[issue.size];
    await fullPipeline(issue.description + issueRef, {
      pipelineRunId,
      issueSize: issue.size,
      resumeFrom: executionStart,
      mode: "execution",
    });

    // Mark done (re-read backlog to avoid conflicts)
    const freshBacklog = loadBacklog();
    const freshIssue = freshBacklog.issues.find(i => i.id === issue.id)!;
    freshIssue.status = "done";
    freshIssue.completedAt = new Date().toISOString();
    freshIssue.updatedAt = new Date().toISOString();
    saveBacklog(freshBacklog);

    const ghNum = freshIssue.githubIssueNumber;
    const repo = activeProject?.repo?.trim();
    const ghToken = process.env.GITHUB_TOKEN?.trim();
    if (
      isGithubCloseIssueOnPipelineDoneEnabled() &&
      ghNum != null &&
      repo &&
      ghToken
    ) {
      try {
        await closeGitHubIssueWithComment(repo, ghToken, ghNum, githubPipelineCloseComment(freshIssue));
      } catch (e) {
        console.warn(`GitHub fermeture automatique : ${formatErrorMessage(e)}`);
      }
    }

    console.log(`\n✅ Issue ${issue.id} marquée DONE dans backlog.json`);
  } catch (err) {
    // Revert to todo on failure
    const freshBacklog = loadBacklog();
    const freshIssue = freshBacklog.issues.find(i => i.id === issue.id)!;
    freshIssue.status = "todo";
    freshIssue.pipelineRun = null;
    freshIssue.updatedAt = new Date().toISOString();
    saveBacklog(freshBacklog);
    throw err;
  }
}

async function pipelineBacklogReflection(
  direction: "forward" | "backward",
  brief: string,
): Promise<void> {
  const source = direction === "forward" ? "top_down" : "bottom_up";
  const label = direction === "forward" ? "métavision (top-down)" : "feedback (bottom-up)";
  console.log("═".repeat(60));
  console.log(`🧭 PIPELINE BACKLOG (${direction}) — Réflexion -> Backlog`);
  console.log("═".repeat(60));
  console.log(`   Source attendue : ${label}`);

  const frugal = await checkFrugalMode(process.env);
  const pmTask = direction === "forward"
    ? "À partir de cette métavision, génère/structure des user stories backlog actionnables avec priorités, tailles et critères d'acceptation."
    : "À partir de ce feedback terrain, révise et complète le backlog en ajustant priorités, tailles et critères d'acceptation.";
  const specs = await runAgent("pm", pmTask, {
    additionalContext: brief,
    frugal,
  });

  const architecture = await runAgent(
    "architect",
    "Produit la vision architecture cible pour les items Must/Should du backlog (cible, hypothèses/contraintes, alternative, risques).",
    { additionalContext: specs, frugal }
  );

  const reflection = await runAgent(
    "redteam_reflection",
    "Challenge la cohérence produit/architecture et propose les ajustements backlog nécessaires.",
    { additionalContext: `## Backlog\n${specs}\n\n## Vision architecture\n${architecture}`, frugal }
  );

  const parsedIssues = parsePMOutput(specs);
  if (parsedIssues.length === 0) {
    console.log("⚠️  Aucune issue parsée depuis la sortie PM — backlog non modifié.");
    return;
  }

  const backlog = loadBacklog();
  const now = new Date().toISOString();
  const architectureSummary = previewText(architecture, 500);
  const reflectionSummary = previewText(reflection, 500);

  for (const parsed of parsedIssues) {
    const existing = backlog.issues.find(i => i.title.trim().toLowerCase() === parsed.title.trim().toLowerCase());
    if (existing) {
      existing.description = parsed.description;
      existing.priority = parsed.priority;
      existing.size = parsed.size;
      existing.source = source;
      if (existing.priority === "MUST" || existing.priority === "SHOULD") {
        existing.architectureVision = architectureSummary;
        existing.reflectionChallenge = reflectionSummary;
      }
      existing.updatedAt = now;
      continue;
    }

    const id = generateIssueId(backlog);
    backlog.issues.push({
      ...parsed,
      id,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      pipelineRun: null,
      source,
      architectureVision: parsed.priority === "MUST" || parsed.priority === "SHOULD" ? architectureSummary : undefined,
      reflectionChallenge: parsed.priority === "MUST" || parsed.priority === "SHOULD" ? reflectionSummary : undefined,
    });
  }

  saveBacklog(backlog);
  console.log(`\n✅ Backlog mis à jour via pipeline backlog ${direction} (${parsedIssues.length} item(s) traités).`);
  printBacklogSummary(backlog);
}

// ------------------------------------------------------------
// Pipelines
// ------------------------------------------------------------

/**
 * Pipeline full en 2 macro-parties :
 * 1) Réflexion -> Backlog : PM -> Architect -> Red Team Réflexion
 * 2) Exécution backlog -> QA : Dev -> Sécurité -> QA
 *
 * Variante A imposée : sécurité avant QA.
 *
 * @param brief - Brief de départ (ou sortie d'étapes précédentes si resumeFrom est utilisé)
 * @param opts.resumeFrom - Reprendre depuis cette étape (les étapes antérieures sont ignorées)
 * @param opts.pipelineRunId - Identifiant stable pour lier l'exécution au champ `pipelineRun` du backlog
 */
async function fullPipeline(
  brief: string,
  opts: {
    resumeFrom?: PipelineStep;
    pipelineRunId?: string;
    issueSize?: IssueSize;
    mode?: "full" | "execution";
  } = {}
) {
  // Mode full: démarre en réflexion (PM). Mode execution: démarre depuis l'étape donnée ou dev.
  const isExecutionOnly = opts.mode === "execution";
  const resumeFrom = opts.resumeFrom ?? (isExecutionOnly ? "dev" : "pm");
  const startIdx = PIPELINE_STEPS.indexOf(resumeFrom);
  const runId = opts.pipelineRunId ?? newPipelineRunId();
  const startedAt = new Date().toISOString();

  // Vérification du budget — réévaluée avant chaque étape cloud pour basculer en frugal en cours de pipeline
  let frugal = await checkFrugalMode(process.env);
  if (frugal) {
    console.warn(
      "\n⚠️  MODE FRUGAL activé pour ce run.\n" +
      "   (solo par défaut, override FRUGAL_DEFAULT ou seuil Team SPEND_ALERT_CENTS)\n"
    );
  }

  let qaIteration = 0;
  let securityIteration = 0;
  let qaEscalated = false;
  let securityEscalated = false;
  let mediumSecurityNotes = false;
  let runStatus: PipelineRunStatus = "success";

  const briefForRecord =
    brief.length > 50_000 ? `${brief.slice(0, 50_000)}\n\n[… tronqué pour pipeline-runs.json …]` : brief;

  const pipelineIssueSize = opts.issueSize;

  try {
    console.log("═".repeat(60));
    console.log(
      isExecutionOnly
        ? "🏗️  PIPELINE NEXT — Exécution Backlog -> QA"
        : "🏗️  PIPELINE FULL — Réflexion -> Backlog -> Exécution -> QA"
    );
    if (pipelineIssueSize) {
      console.log(`   📐 Taille issue (grille modèles) : ${pipelineIssueSize}`);
    }
    if (resumeFrom !== "pm") {
      const reason = "--resume-from explicite";
      console.log(`   ⏩ Démarrage depuis : ${resumeFrom.toUpperCase()} (${reason})`);
    }
    console.log("═".repeat(60));

    // Quand on reprend depuis une étape intermédiaire, le brief joue le rôle
    // du contexte accumulé des étapes précédentes.
    let specs = brief;
    let architectureVision = "";
    let reflectionChallenge = "";

    // ── Étape 1 : Product Manager (Réflexion) ──
    if (!isExecutionOnly && startIdx <= 0) {
      console.log("\n📋 ÉTAPE 1/6 — Product Manager (Réflexion -> Backlog)");
      const pmOutput = await runAgent(
        "pm",
        "Formalise le backlog (Must/Should/Could/Wont) en distinguant explicitement la provenance top_down ou bottom_up de chaque item.",
        { additionalContext: brief, frugal, issueSize: pipelineIssueSize }
      );
      if (pmOutput.trim()) {
        specs = pmOutput;
      }
    } else if (!isExecutionOnly) {
      console.log("\n📋 ÉTAPE 1/6 — Product Manager : ⏭  ignoré (--resume-from)");
    } else {
      console.log("\n📋 ÉTAPE 1/6 — Product Manager : ⏭  ignoré (mode execution)");
    }

    // ── Étape 2 : Architect (cadrage architecture amont, ou garde-fou execution selon taille) ──
    if (startIdx <= 1) {
      console.log("\n🏛️  ÉTAPE 2/6 — Data Architect");
      architectureVision = await runAgent(
        "architect",
        isExecutionOnly
          ? "Fournis un cadrage architecture ciblé pour sécuriser l'exécution de ce backlog item (contraintes, risques, points d'attention)."
          : "Établis la vision architecture cible, les contraintes, une alternative crédible et les risques principaux pour les items Must/Should.",
        { additionalContext: specs, frugal, issueSize: pipelineIssueSize }
      );
    } else {
      console.log("\n🏛️  ÉTAPE 2/6 — Data Architect : ⏭  ignoré (--resume-from)");
    }

    // ── Étape 3 : Red Team Réflexion (challenge produit + architecture) ──
    if (!isExecutionOnly && startIdx <= 2) {
      console.log("\n🧠 ÉTAPE 3/6 — Red Team Réflexion");
      reflectionChallenge = await runAgent(
        "redteam_reflection",
        "Challenge la cohérence produit/architecture, explicite les hypothèses à risque et propose des alternatives actionnables pour backlog Must/Should.",
        {
          additionalContext: `## Specs backlog\n${specs}\n\n## Vision architecture\n${architectureVision}`,
          frugal,
          issueSize: pipelineIssueSize,
        }
      );
    } else if (!isExecutionOnly) {
      console.log("\n🧠 ÉTAPE 3/6 — Red Team Réflexion : ⏭  ignoré (--resume-from)");
    } else {
      console.log("\n🧠 ÉTAPE 3/6 — Red Team Réflexion : ⏭  ignoré (mode execution)");
    }

    // ── Exécution : Dev -> Sécurité -> QA ──
    const devContext = [
      `## Brief d'origine\n${brief}`,
      specs !== brief ? `## Backlog formalisé\n${specs}` : null,
      architectureVision ? `## Vision architecture\n${architectureVision}` : null,
      reflectionChallenge ? `## Challenge produit/architecture\n${reflectionChallenge}` : null,
    ].filter(Boolean).join("\n\n");

    if (startIdx <= 3) {
      console.log("\n💻 ÉTAPE 4/6 — Développeur Full-Stack");
      frugal = frugal || await checkFrugalMode(process.env);
      if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");
    }

    let implementation = startIdx <= 3
      ? await runAgent(
          "dev",
          "Implémente les fonctionnalités du backlog Must/Should en respectant la vision architecture et ouvre/met à jour la PR.",
          { additionalContext: devContext, cloud: true, autoCreatePR: true, frugal, issueSize: pipelineIssueSize }
        )
      : brief;

    // ── Étape 5 : Sécurité avec boucle feedback ──
    let securityApproved = startIdx > 4;
    const maxSecurityIterations = 3;
    let securityReport = "";

    if (startIdx > 4) {
      console.log("\n🔐 ÉTAPE 5/6 — Sécurité : ⏭  ignoré (--resume-from)");
    } else {
      while (!securityApproved && securityIteration < maxSecurityIterations) {
        securityIteration++;
        console.log(`\n🔐 ÉTAPE 5/6 — Sécurité — itération ${securityIteration}/${maxSecurityIterations}`);
        frugal = frugal || await checkFrugalMode(process.env);
        if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");

        const securityPrompt = securityIteration === 1
          ? "Audite la PR pour les vulnérabilités de sécurité."
          : `Re-audite après corrections.\n\nRapport précédent sécurité :\n${securityReport}`;

        securityReport = await runAgent(
          "security",
          securityPrompt,
          {
            additionalContext: implementation,
            cloud: true,
            frugal,
            issueSize: pipelineIssueSize,
          }
        );

        const securityVerdict = detectSecurityVerdict(securityReport);
        if (securityVerdict === "APPROVED") {
          securityApproved = true;
          console.log("✅ Sécurité approuvée — passage à QA.\n");
        } else if (securityVerdict === "CRITICAL_ISSUES" && securityIteration < maxSecurityIterations) {
          console.log("🔄 Vulnérabilités critiques — relance du développeur.\n");
          implementation = await runAgent(
            "dev",
            `Corrige les vulnérabilités critiques signalées par la sécurité.\n\n${securityReport}`,
            {
              additionalContext: devContext,
              cloud: true,
              autoCreatePR: false,
              frugal,
              issueSize: pipelineIssueSize,
            }
          );
        } else if (securityVerdict === "MEDIUM_ISSUES") {
          mediumSecurityNotes = true;
          securityApproved = true;
          console.log("⚠️  Vulnérabilités moyennes — passage avec documentation.\n");
        } else {
          securityEscalated = true;
          securityApproved = true;
          console.log("⚠️  Sécurité non approuvée après 3 itérations — escalade manuelle recommandée.\n");
        }
      }
    }

    // ── Étape 6 : QA avec feedback + re-challenge sécurité en cas de retouche Dev ──
    let qaApproved = false;
    const maxQAIterations = 3;
    let qaReport = "";

    while (!qaApproved && qaIteration < maxQAIterations) {
      qaIteration++;
      console.log(`\n🧪 ÉTAPE 6/6 — QA Engineer — itération ${qaIteration}/${maxQAIterations}`);
      frugal = frugal || await checkFrugalMode(process.env);
      if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");

      const qaPrompt = qaIteration === 1
        ? "Review la PR créée par le développeur. Vérifie le code, les tests, et la conformité au backlog."
        : `Re-review la PR après les changements du développeur.\n\nVoici le rapport précédent de QA :\n${qaReport}\n\nVérifie si les problèmes identifiés ont été correctement adressés.`;

      qaReport = await runAgent(
        "qa",
        qaPrompt,
        {
          additionalContext: [
            `## Backlog formalisé\n${specs}`,
            architectureVision ? `## Vision architecture\n${architectureVision}` : null,
            reflectionChallenge ? `## Challenge amont\n${reflectionChallenge}` : null,
            securityReport ? `## Rapport sécurité\n${securityReport}` : null,
            `## Implémentation\n${implementation}`,
          ].filter(Boolean).join("\n\n"),
          cloud: true,
          frugal,
          issueSize: pipelineIssueSize,
        }
      );

      const verdict = detectQAVerdict(qaReport);
      if (verdict === "APPROVE") {
        qaApproved = true;
        console.log("✅ QA approuve — pipeline complet.\n");
        continue;
      }

      if (qaIteration >= maxQAIterations) {
        qaEscalated = true;
        qaApproved = true;
        console.log("⚠️  QA non approuvée après 3 itérations — escalade manuelle recommandée.\n");
        continue;
      }

      console.log("🔄 QA demande des changements — relance développeur puis re-challenge sécurité.\n");
      implementation = await runAgent(
        "dev",
        `Corrige les problèmes soulevés par QA dans la revue précédente :\n\n${qaReport}\n\nMet à jour la PR avec les changements.`,
        {
          additionalContext: devContext,
          cloud: true,
          autoCreatePR: false,
          frugal,
          issueSize: pipelineIssueSize,
        }
      );

      // Variante A imposée: toute retouche post-sécurité est re-vérifiée avant la QA suivante.
      const securityAfterQaFix = await runAgent(
        "security",
        "Re-vérifie rapidement les impacts sécurité après corrections demandées par QA.",
        {
          additionalContext: implementation,
          cloud: true,
          frugal,
          issueSize: pipelineIssueSize,
        }
      );
      securityReport = securityAfterQaFix;
      const securityVerdict = detectSecurityVerdict(securityAfterQaFix);
      if (securityVerdict === "CRITICAL_ISSUES") {
        implementation = await runAgent(
          "dev",
          `Corrige les vulnérabilités critiques apparues après corrections QA :\n\n${securityAfterQaFix}`,
          {
            additionalContext: devContext,
            cloud: true,
            autoCreatePR: false,
            frugal,
            issueSize: pipelineIssueSize,
          }
        );
      } else if (securityVerdict === "MEDIUM_ISSUES") {
        mediumSecurityNotes = true;
      }
    }

    // ── Résumé final ──
    const skipped = (step: PipelineStep) => PIPELINE_STEPS.indexOf(step) < startIdx;
    if (qaEscalated || securityEscalated || mediumSecurityNotes) {
      runStatus = "partial";
    }

    console.log("\n" + "═".repeat(60));
    console.log("📊 PIPELINE TERMINÉ — Résumé");
    console.log("═".repeat(60));
    console.log(`1. Backlog PM                : ${skipped("pm") ? "⏭  ignoré" : "✅ formalisé"}`);
    console.log(`2. Vision architecture       : ${skipped("architect") ? "⏭  ignoré" : "✅ cadrée"}`);
    console.log(`3. Red Team réflexion        : ${skipped("redteam_reflection") ? "⏭  ignoré" : "✅ challenge produit/archi"}`);
    console.log(`4. Implémentation            : ${skipped("dev") ? "⏭  ignoré" : "✅ PR mise à jour"}`);
    console.log(`5. Sécurité                  : ${skipped("security") ? "⏭  ignoré" : `✅ complétée (${securityIteration} itération${securityIteration > 1 ? "s" : ""})`}`);
    console.log(`6. Review QA                 : ${skipped("qa") ? "⏭  ignoré" : `✅ approuvée (${qaIteration} itération${qaIteration > 1 ? "s" : ""})`}`);
    console.log("\n👉 Va sur GitHub pour review final et merger la PR.");
  } catch (e) {
    runStatus = "failed";
    throw e;
  } finally {
    try {
      appendPipelineRun({
        id: runId,
        brief: briefForRecord,
        resumeFrom: resumeFrom === "pm" ? null : resumeFrom,
        qaIterations: qaIteration,
        securityIterations: securityIteration,
        status: runStatus,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error(
        `   ⚠️  Impossible d'enregistrer l'exécution du pipeline dans pipeline-runs.json : ${(e as Error).message}`
      );
    }
  }
}

// ------------------------------------------------------------
// Point d'entrée
// ------------------------------------------------------------

async function main() {
  // Vérification de la clé API
  if (!process.env.CURSOR_API_KEY) {
    console.error("❌ CURSOR_API_KEY manquante. Copie .env.example en .env et remplis-la.");
    process.exit(1);
  }

  // Parse des arguments CLI
  const args = process.argv.slice(2);

  // Charger le projet s'il est spécifié
  const projectFlag = args.indexOf("--project");
  if (projectFlag !== -1) {
    let projectPath = args[projectFlag + 1];
    if (!projectPath || projectPath.startsWith("--")) {
      console.error(
        "❌ --project nécessite un nom ou un chemin (ex. geneweb-py ou projects/geneweb-py.md)."
      );
      process.exit(1);
    }
    // Résolution automatique : "geneweb-py" → "projects/geneweb-py.md"
    if (!projectPath.includes("/") && !projectPath.endsWith(".md")) {
      projectPath = `projects/${projectPath}.md`;
    }
    activeProject = loadProject(projectPath);
    activeProjectSlug = basename(projectPath, ".md")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || null;
    console.log(`🎯 Projet : ${activeProject.name} (${activeProject.branch})`);
    // Surcharger les variables d'environnement avec les valeurs du projet
    if (activeProject.repo) process.env.TARGET_REPO_URL = activeProject.repo;
    if (activeProject.branch) process.env.TARGET_BRANCH = activeProject.branch;
  }

  // --brief-file : lit le brief depuis un fichier plutôt que depuis la CLI
  let briefFromFile: string | null = null;
  const briefFileFlag = args.indexOf("--brief-file");
  if (briefFileFlag !== -1 && args[briefFileFlag + 1]) {
    let briefFilePath: string;
    try {
      briefFilePath = resolveBriefFilePath(args[briefFileFlag + 1], process.cwd());
    } catch (e) {
      console.error(`❌ --brief-file : ${(e as Error).message}`);
      process.exit(1);
    }
    if (!existsSync(briefFilePath)) {
      console.error(`❌ --brief-file : fichier introuvable : ${briefFilePath}`);
      process.exit(1);
    }
    const { displayPath: briefDisplay } = resolveUserPath(briefFilePath);
    briefFromFile = readFileSync(briefFilePath, "utf-8").trim();
    console.log(`📄 Brief chargé depuis : ${briefDisplay}`);
  }

  // --resume-from : reprendre le pipeline à une étape donnée
  let resumeFrom: PipelineStep | undefined;
  const resumeFlag = args.indexOf("--resume-from");
  if (resumeFlag !== -1 && args[resumeFlag + 1]) {
    const step = args[resumeFlag + 1] as PipelineStep;
    if (!PIPELINE_STEPS.includes(step)) {
      console.error(`❌ --resume-from : étape inconnue « ${step} »`);
      console.error(`   Étapes valides : ${PIPELINE_STEPS.join(", ")}`);
      process.exit(1);
    }
    resumeFrom = step;
  }

  const roleFlag = args.indexOf("--role");
  const pipelineFlag = args.indexOf("--pipeline");
  const pmBacklogFlag = args.indexOf("--pm-backlog");
  const backlogFlag = args.indexOf("--backlog");

  if (roleFlag !== -1 && args[roleFlag + 1]) {
    // Mode agent unique : npm run agent:pm "Ma tâche"
    const role = args[roleFlag + 1] as AgentRole;
    const taskFromCli = args.slice(roleFlag + 2).join(" ");
    const task = briefFromFile ?? (taskFromCli || "Analyse le projet et propose des améliorations.");

    if (!(role in AGENT_CONFIG)) {
      console.error(`❌ Rôle inconnu : ${role}`);
      console.error(`   Rôles disponibles : ${Object.keys(AGENT_CONFIG).join(", ")}`);
      process.exit(1);
    }

    const frugal = await checkFrugalMode(process.env);
    // Use cloud mode for direct agent invocation
    await runAgent(role, task, { cloud: true, frugal });
  } else if (pipelineFlag !== -1) {
    // Mode pipeline : npm run pipeline [next|full|"Mon brief"]
    const subcommand = args[pipelineFlag + 1];
    if (subcommand === "next") {
      await pipelineNext();
    } else if (subcommand === "backlog") {
      const direction = args[pipelineFlag + 2];
      if (direction !== "forward" && direction !== "backward") {
        console.error("❌ --pipeline backlog attend 'forward' ou 'backward'.");
        process.exit(1);
      }
      const briefFromCli = args.slice(pipelineFlag + 3).join(" ");
      const brief = briefFromFile ?? (briefFromCli || "Structurer ou réviser le backlog selon le contexte fourni.");
      await pipelineBacklogReflection(direction, brief);
    } else {
      const briefFromCli = args.slice(pipelineFlag + 1).join(" ");
      const brief = briefFromFile ?? (briefFromCli || "Analyse le projet existant et propose des améliorations.");
      await fullPipeline(brief, { resumeFrom, mode: "full" });
    }
  } else if (args.includes("--sync-issues")) {
    // Mode sync GitHub Issues : crée les issues manquantes depuis backlog.json
    if (!activeProject?.repo) {
      console.error("❌ --sync-issues nécessite --project avec un champ repo: dans le frontmatter.");
      process.exit(1);
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.error("❌ --sync-issues nécessite GITHUB_TOKEN dans .env.");
      process.exit(1);
    }
    const backlog = loadBacklog();
    const count = await syncBacklogToGitHub(backlog, activeProject.repo, token);
    if (count > 0) saveBacklog(backlog);
  } else if (pmBacklogFlag !== -1) {
    // Mode PM backlog : npm run pm:backlog
    await pmBacklogWorkflow();
  } else if (backlogFlag !== -1) {
    // Mode backlog view : npm run backlog
    printBacklogSummary();
  } else {
    // Mode par défaut : affiche l'aide
    console.log(`
╔══════════════════════════════════════════════════════════╗
║         🤖 AI Team Orchestrator — v0.1.0                ║
╚══════════════════════════════════════════════════════════╝

Usage :
  npm run agent:pm "Brief de la fonctionnalité"
  npm run agent:architect "Conçois le modèle de données pour X"
  npm run agent:dev "Implémente la page d'upload de dataset"
  npm run agent:qa "Review la PR #42"
  npm run agent:security "Audite la sécurité de l'app"
  npm run agent:redteam_reflection "Challenge produit/architecture"

  npm run pipeline "Brief complet du projet"
    → Lance le pipeline complet : PM → Archi → Red Team Réflexion → Dev → Sécurité → QA

  npm run project -- monprojet --pipeline backlog forward "Méta-vision produit"
    → Lance la partie réflexion et met à jour backlog.json (top-down)

  npm run project -- monprojet --pipeline backlog backward "Feedback utilisateur/testeurs"
    → Lance la partie réflexion et révise backlog.json (bottom-up)

  npm run pm:backlog
    → PM analyse le repo et génère backlog.json avec issues prioritaires

  npm run backlog
    → Affiche l'état du backlog (todo/in_progress/done)

  npm test
    → Exécute les tests unitaires (validation backlog.json côté modèle)

  npm run pipeline:next
    → Prend la prochaine issue MUST→SHOULD→COULD et lance la partie exécution (depuis dev, ou architect selon taille)

  npm run project:dataset-style -- --backlog
    → Lance une commande avec contexte projet spécifique

Options globales :
  --project <file>
    → Charge le contexte du projet depuis projects/<file>.md
    → Injecte automatiquement stack, conventions et contraintes dans tous les agents

  --brief-file <file>
    → Lit le brief/tâche depuis un fichier plutôt que depuis la CLI
    → Chemin relatif au répertoire courant ou chemin absolu
    → Permet de passer de longs textes (ex: last-run/pm.md comme brief pour l'architecte)
    → Compatible avec --role, --pipeline

  --resume-from <step>
    → Reprend le pipeline à une étape donnée en ignorant les étapes précédentes
    → Étapes : pm | architect | redteam_reflection | dev | security | qa
    → Le brief fourni joue le rôle du contexte accumulé des étapes ignorées
    → Exemple : après un --role pm, passer last-run/pm.md à --pipeline avec --resume-from architect

Agents disponibles :
${Object.entries(AGENT_CONFIG)
  .map(([key, val]) => `  ${key.padEnd(12)} ${val.description}`)
  .join("\n")}
    `);
  }
}

main().catch((err) => {
  console.error("❌ Erreur fatale :", err.message);
  process.exit(1);
});
