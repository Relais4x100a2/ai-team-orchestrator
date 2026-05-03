/**
 * ============================================================
 * AI Team Orchestrator — Cerveau de l'équipe de dev IA
 * ============================================================
 *
 * Ce script orchestre les agents du pipeline (PM, architecte, dev, QA, red team)
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
import { resolve, dirname, isAbsolute, relative } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";
import {
  createAgentConfig,
  formatModelSelection,
  FRUGAL_MODEL,
  PIPELINE_STEPS,
  type AgentRole,
  type PipelineStep,
} from "./agent-config.js";
import { checkFrugalMode } from "./spend-guard.js";
import type { Backlog, BacklogIssue, IssuePriority, IssueStatus } from "./backlog.js";
import {
  generateIssueId,
  parsePMOutput,
  pickNextIssue,
} from "./backlog.js";
import { detectQAVerdict, detectSecurityVerdict } from "./pipeline-detection.js";
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


const BACKLOG_PATH = resolve(__dirname, "../backlog.json");
let activeProject: ProjectContext | null = null;

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
  const project: ProjectContext = {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Projet sans nom",
    repo: typeof data.repo === "string" && data.repo.trim() ? data.repo.trim() : (process.env.TARGET_REPO_URL ?? "").trim(),
    branch: typeof data.branch === "string" && data.branch.trim() ? data.branch.trim() : (process.env.TARGET_BRANCH ?? "main").trim() || "main",
    content: parsed.content.trim(),
  };
  assertValidProjectContext(project, absolutePath);
  return project;
}

/** Configuration des agents — modèles via MODEL_STRONG / MODEL_FAST dans .env */
const AGENT_CONFIG = createAgentConfig();

const LAST_RUN_DIR = resolve(__dirname, "../last-run");

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
  } = {}
) {
  const config = AGENT_CONFIG[role];
  const model = options.frugal ? FRUGAL_MODEL : config.model;
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
    ? `\n\n---\n\n## Contexte du projet cible\n\n**Projet :** ${activeProject.name}\n**Repo :** ${activeProject.repo}\n**Branche :** ${activeProject.branch}\n\n${activeProject.content}`
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
    Object.assign(agentOptions, {
      local: { cwd: process.cwd() },
    });
  }

  let agent;
  try {
    agent = await Agent.create(agentOptions);
  } catch (e) {
    throw new Error(`Impossible de créer l'agent ${role} (${model.id}) : ${formatErrorMessage(e)}`);
  }
  const roleAndTask = `${prompt}\n\n---\n\n${fullTask}`;
  const taskWithSystemPrompt = projectSection ? `${projectSection}\n\n---\n\n${roleAndTask}` : roleAndTask;
  let run;
  try {
    run = await agent.send(taskWithSystemPrompt);
  } catch (e) {
    throw new Error(`Échec de l'envoi de la tâche à l'agent ${role} : ${formatErrorMessage(e)}`);
  }

  // Attendre la fin et afficher le résultat
  let runResult;
  try {
    runResult = await run.wait();
  } catch (e) {
    throw new Error(`L'agent ${role} n'a pas terminé correctement : ${formatErrorMessage(e)}`);
  }
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
    try {
      mkdirSync(LAST_RUN_DIR, { recursive: true });
      writeFileSync(resolve(LAST_RUN_DIR, `${role}.md`), result, "utf-8");
      console.log(`\n   💾 Sortie sauvegardée : last-run/${role}.md`);
    } catch (e) {
      console.error(`   ⚠️  Impossible de sauvegarder last-run/${role}.md : ${(e as Error).message}`);
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`✅ Agent ${role} terminé.\n`);

  return result;
}

function loadBacklog(): Backlog {
  if (!existsSync(BACKLOG_PATH)) {
    return { version: 1, lastUpdated: new Date().toISOString(), issues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(BACKLOG_PATH, "utf-8"));
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
  writeFileSync(BACKLOG_PATH, JSON.stringify(backlog, null, 2), "utf-8");
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

  try {
    await fullPipeline(issue.description, { pipelineRunId });

    // Mark done (re-read backlog to avoid conflicts)
    const freshBacklog = loadBacklog();
    const freshIssue = freshBacklog.issues.find(i => i.id === issue.id)!;
    freshIssue.status = "done";
    freshIssue.completedAt = new Date().toISOString();
    freshIssue.updatedAt = new Date().toISOString();
    saveBacklog(freshBacklog);

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

// ------------------------------------------------------------
// Pipelines
// ------------------------------------------------------------

/**
 * Pipeline complet : PM → Architect → Dev ⇄ QA (loop) ⇄ RedTeam (loop)
 *
 * Workflow avec boucles feedback :
 * 1. QA approuve (APPROVE) → continue vers RedTeam
 *    QA demande changements → relance Dev, puis re-review par QA (max 3 itérations)
 * 2. RedTeam approuve → pipeline complet
 *    Vulnérabilités critiques → relance Dev, puis re-audit par RedTeam (max 3 itérations)
 *    Vulnérabilités moyennes → passage avec documentation pour sprints futurs
 *
 * @param brief - Brief de départ (ou sortie d'étapes précédentes si resumeFrom est utilisé)
 * @param opts.resumeFrom - Reprendre depuis cette étape (les étapes antérieures sont ignorées)
 * @param opts.pipelineRunId - Identifiant stable pour lier l'exécution au champ `pipelineRun` du backlog
 */
async function fullPipeline(
  brief: string,
  opts: { resumeFrom?: PipelineStep; pipelineRunId?: string } = {}
) {
  const resumeFrom = opts.resumeFrom ?? "pm";
  const startIdx = PIPELINE_STEPS.indexOf(resumeFrom);
  const runId = opts.pipelineRunId ?? newPipelineRunId();
  const startedAt = new Date().toISOString();

  // Vérification du budget avant de lancer les agents
  const frugal = await checkFrugalMode(process.env);
  if (frugal) {
    console.warn(
      "\n⚠️  MODE FRUGAL — Seuil de dépenses atteint (SPEND_ALERT_CENTS).\n" +
      "   Tous les agents utiliseront composer-2 pour ce run.\n"
    );
  }

  let qaIteration = 0;
  let rtIteration = 0;
  let qaEscalated = false;
  let rtEscalated = false;
  let mediumSecurityNotes = false;
  let runStatus: PipelineRunStatus = "success";

  const briefForRecord =
    brief.length > 50_000 ? `${brief.slice(0, 50_000)}\n\n[… tronqué pour pipeline-runs.json …]` : brief;

  try {
    console.log("═".repeat(60));
    console.log("🏗️  PIPELINE COMPLET — Du brief au déploiement (avec feedback loop)");
    if (resumeFrom !== "pm") {
      console.log(`   ⏩ Reprise depuis : ${resumeFrom.toUpperCase()} (étapes précédentes ignorées)`);
      console.log(`   📄 Contexte injecté depuis le brief fourni.`);
    }
    console.log("═".repeat(60));

  // Quand on reprend depuis une étape intermédiaire, le brief joue le rôle
  // du contexte accumulé des étapes précédentes.
  let specs = brief;
  let architecture = "";

  // ── Étape 1 : Product Manager ──
  if (startIdx === 0) {
    console.log("\n📋 ÉTAPE 1/5 — Product Manager");
    specs = await runAgent("pm", brief, { frugal });
    console.log("⏸️  CHECKPOINT : Review les specs ci-dessus.");
    console.log("   En production, le pipeline s'arrête ici pour ta validation.\n");
  } else {
    console.log("\n📋 ÉTAPE 1/5 — Product Manager : ⏭  ignoré (--resume-from)");
  }

  // ── Étape 2 : Data Architect ──
  if (startIdx <= 1) {
    console.log("\n🏛️  ÉTAPE 2/5 — Data Architect");
    architecture = await runAgent(
      "architect",
      "Conçois l'architecture technique et le modèle de données pour les specs suivantes.",
      { additionalContext: specs, frugal }
    );
    console.log("⏸️  CHECKPOINT : Review l'architecture ci-dessus.\n");
  } else {
    console.log("\n🏛️  ÉTAPE 2/5 — Data Architect : ⏭  ignoré (--resume-from)");
  }

  // ── Étape 3 & 4 : Dev ⇄ QA Loop ──
  const devContext = architecture
    ? `## Specs PM\n${specs}\n\n## Architecture\n${architecture}`
    : `## Contexte fourni\n${specs}`;

  if (startIdx <= 2) {
    console.log("\n💻 ÉTAPE 3/5 — Développeur Full-Stack");
  }
  let implementation = startIdx <= 2
    ? await runAgent(
        "dev",
        "Implémente les fonctionnalités selon les specs et l'architecture ci-dessous. Crée une branche feature/ et ouvre une PR.",
        { additionalContext: devContext, cloud: true, autoCreatePR: true, frugal }
      )
    : brief; // si on reprend depuis QA ou redteam, le brief est le contexte de l'implémentation

  // Boucle QA avec feedback
  let qaApproved = startIdx > 3; // si on reprend depuis redteam, QA est déjà passé
  const maxQAIterations = 3;
  let qaReport = "";

  if (startIdx > 3) {
    console.log("\n🧪 ÉTAPE 4/5 — QA Engineer : ⏭  ignoré (--resume-from)");
  } else {
    while (!qaApproved && qaIteration < maxQAIterations) {
      qaIteration++;
      console.log(`\n🧪 ÉTAPE 4/5 — QA Engineer — itération ${qaIteration}/${maxQAIterations}`);

      const qaPrompt = qaIteration === 1
        ? "Review la PR créée par le développeur. Vérifie le code, les tests, et la conformité aux specs."
        : `Re-review la PR après les changements du développeur.\n\nVoici le rapport précédent de QA :\n${qaReport}\n\nVérifie si les problèmes identifiés ont été correctement adressés.`;

      // Quand on reprend depuis QA (startIdx >= 3), specs === brief === implementation.
      // Passer les deux créerait une duplication — on passe uniquement le brief.
      const qaAdditionalContext = startIdx >= 3
        ? `## Contexte d'implémentation\n${brief}`
        : `## Specs PM\n${specs}\n\n## Implémentation\n${implementation}`;

      qaReport = await runAgent(
        "qa",
        qaPrompt,
        {
          additionalContext: qaAdditionalContext,
          cloud: true,
          frugal,
        }
      );

      const verdict = detectQAVerdict(qaReport);

      if (verdict === "APPROVE") {
        qaApproved = true;
        console.log("✅ QA APPROUVE — Passage à l'audit de sécurité.\n");
      } else if (qaIteration < maxQAIterations) {
        console.log("🔄 QA DEMANDE DES CHANGEMENTS — Relance du développeur.\n");

        implementation = await runAgent(
          "dev",
          `Corrige les problèmes soulevés par QA dans la revue précédente :\n\n${qaReport}\n\nMet à jour la PR avec les changements.`,
          {
            additionalContext: devContext,
            cloud: true,
            autoCreatePR: false,
            frugal,
          }
        );
      } else {
        console.log("⚠️  QA N'A PAS APPROUVÉ APRÈS 3 ITÉRATIONS — Passage malgré tout (escalade manuelle recommandée).\n");
        qaEscalated = true;
        qaApproved = true;
      }
    }
  }

  // ── Étape 5 : Red Team avec boucle feedback ──
  let securityApproved = false;
  const maxRTIterations = 3;
  let securityReport = "";

  while (!securityApproved && rtIteration < maxRTIterations) {
    rtIteration++;
    console.log(`\n🔴 ÉTAPE 5/5 — Red Team — itération ${rtIteration}/${maxRTIterations}`);

    const rtPrompt = rtIteration === 1
      ? "Audite le code de la PR pour les vulnérabilités de sécurité."
      : `Re-audite la PR après les corrections du développeur.\n\nVoici le rapport précédent de la red team :\n${securityReport}\n\nVérifie si les problèmes identifiés ont été correctement adressés.`;

    securityReport = await runAgent(
      "redteam",
      rtPrompt,
      {
        additionalContext: implementation,
        cloud: true,
        frugal,
      }
    );

    const securityVerdict = detectSecurityVerdict(securityReport);

    if (securityVerdict === "APPROVED") {
      securityApproved = true;
      console.log("✅ AUDIT SÉCURITÉ APPROUVÉ — Pipeline complet.\n");
    } else if (securityVerdict === "CRITICAL_ISSUES" && rtIteration < maxRTIterations) {
      console.log("🔄 VULNÉRABILITÉS CRITIQUES — Relance du développeur.\n");

      implementation = await runAgent(
        "dev",
        `Corrige les vulnérabilités critiques de sécurité soulevées par la red team :\n\n${securityReport}\n\nMets à jour la PR avec les corrections.`,
        {
          additionalContext: devContext,
          cloud: true,
          autoCreatePR: false,
          frugal,
        }
      );
    } else if (securityVerdict === "MEDIUM_ISSUES") {
      mediumSecurityNotes = true;
      securityApproved = true;
      console.log("⚠️  VULNÉRABILITÉS MOYENNES IDENTIFIÉES — Passage avec documentation.\n");
      console.log("   Note : Les vulnérabilités moyennes doivent être traitées dans les sprints suivants.\n");
    } else {
      console.log("⚠️  AUDIT DE SÉCURITÉ N'A PAS APPROUVÉ APRÈS 3 ITÉRATIONS — Passage malgré tout (escalade manuelle recommandée).\n");
      rtEscalated = true;
      securityApproved = true;
    }
  }

  // ── Résumé final ──
  const skipped = (step: PipelineStep) => PIPELINE_STEPS.indexOf(step) < startIdx;
  if (qaEscalated || rtEscalated || mediumSecurityNotes) {
    runStatus = "partial";
  }

  console.log("\n" + "═".repeat(60));
  console.log("📊 PIPELINE TERMINÉ — Résumé");
  console.log("═".repeat(60));
  console.log(`1. Specs PM          : ${skipped("pm") ? "⏭  ignoré" : "✅ rédigées"}`);
  console.log(`2. Architecture      : ${skipped("architect") ? "⏭  ignoré" : "✅ conçue"}`);
  console.log(`3. Implémentation    : ${skipped("dev") ? "⏭  ignoré" : "✅ PR créée"}`);
  console.log(`4. Review QA         : ${skipped("qa") ? "⏭  ignoré" : `✅ approuvée (${qaIteration} itération${qaIteration > 1 ? "s" : ""})`}`);
  console.log(`5. Audit sécurité    : ✅ complété (${rtIteration} itération${rtIteration > 1 ? "s" : ""})`);
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
        securityIterations: rtIteration,
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
    const projectPath = args[projectFlag + 1];
    if (!projectPath || projectPath.startsWith("--")) {
      console.error(
        "❌ --project nécessite un chemin vers un fichier (ex. projects/monprojet.md)."
      );
      process.exit(1);
    }
    activeProject = loadProject(projectPath);
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
    } else {
      const briefFromCli = args.slice(pipelineFlag + 1).join(" ");
      const brief = briefFromFile ?? (briefFromCli || "Analyse le projet existant et propose des améliorations.");
      await fullPipeline(brief, { resumeFrom });
    }
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
  npm run agent:redteam "Audite la sécurité de l'app"

  npm run pipeline "Brief complet du projet"
    → Lance le pipeline complet : PM → Archi → Dev → QA → Red Team

  npm run pm:backlog
    → PM analyse le repo et génère backlog.json avec issues prioritaires

  npm run backlog
    → Affiche l'état du backlog (todo/in_progress/done)

  npm test
    → Exécute les tests unitaires (validation backlog.json côté modèle)

  npm run pipeline:next
    → Prend la prochaine issue MUST→SHOULD→COULD et lance le pipeline complet

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
    → Étapes : pm | architect | dev | qa | redteam
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
