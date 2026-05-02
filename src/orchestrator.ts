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
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";

// Configure ripgrep path for local agent operations
const __dirname = dirname(fileURLToPath(import.meta.url));
const rgPath = resolve(__dirname, "../node_modules/ripgrep/lib/rg.mjs");
if (existsSync(rgPath) && !process.env.RG_PATH) {
  process.env.RG_PATH = rgPath;
}

// Backlog management types
type IssueStatus = "todo" | "in_progress" | "done" | "skipped";
type IssuePriority = "MUST" | "SHOULD" | "COULD" | "WONT";
type IssueSize = "S" | "M" | "L" | "XL";

interface BacklogIssue {
  id: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  size: IssueSize;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  pipelineRun: string | null;
}

interface Backlog {
  version: number;
  lastUpdated: string;
  issues: BacklogIssue[];
}

interface ProjectContext {
  name: string;
  repo: string;
  branch: string;
  content: string;
}

const BACKLOG_PATH = resolve(__dirname, "../backlog.json");
let activeProject: ProjectContext | null = null;

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

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
  const fullPath = resolve(process.cwd(), filePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Projet introuvable : ${fullPath}`);
  }
  const raw = readFileSync(fullPath, "utf-8");
  const { data, content } = matter(raw);
  return {
    name: data.name ?? "Projet sans nom",
    repo: data.repo ?? process.env.TARGET_REPO_URL ?? "",
    branch: data.branch ?? process.env.TARGET_BRANCH ?? "main",
    content: content.trim(),
  };
}

/** Configuration des agents — modèles via MODEL_STRONG / MODEL_FAST dans .env */
const AGENT_CONFIG = {
  // Le PM utilise un modèle puissant car il doit bien comprendre le contexte
  pm: {
    promptFile: "product-manager",
    model: process.env.MODEL_STRONG || "gpt-5-mini",
    description: "Product Manager — specs & backlog",
  },

  // L'architecte a besoin de raisonnement complexe
  architect: {
    promptFile: "data-architect",
    model: process.env.MODEL_STRONG || "gpt-5-mini",
    description: "Data Architect — modèle de données & architecture",
  },

  // L'UX designer peut utiliser un modèle plus léger
  ux: {
    promptFile: "ux-designer",
    model: process.env.MODEL_FAST || "composer-2",
    description: "UX Designer — parcours utilisateur & wireframes",
  },

  // Le dev full-stack utilise un modèle rapide
  dev: {
    promptFile: "fullstack-dev",
    model: process.env.MODEL_FAST || "composer-2",
    description: "Développeur Full-Stack — implémentation",
  },

  // Le QA peut utiliser un modèle rapide pour les reviews
  qa: {
    promptFile: "qa-engineer",
    model: process.env.MODEL_FAST || "composer-2",
    description: "QA Engineer — review & tests",
  },

  // La red team (tâches sensibles) : modèle « strong » mais économique par défaut
  redteam: {
    promptFile: "red-team",
    model: process.env.MODEL_STRONG || "gpt-5-mini",
    description: "Red Team — audit de sécurité",
  },

  devops: {
    promptFile: "devops-platform",
    model: process.env.MODEL_STRONG || "gpt-5-mini",
    description: "DevOps / Plateforme — CI/CD & infra",
  },

  sre: {
    promptFile: "sre-observability",
    model: process.env.MODEL_STRONG || "gpt-5-mini",
    description: "SRE / Observabilité — logs, métriques, alertes",
  },

  release: {
    promptFile: "release-manager",
    model: process.env.MODEL_FAST || "composer-2",
    description: "Release — versioning & changelog",
  },

  ui: {
    promptFile: "ui-designer",
    model: process.env.MODEL_FAST || "composer-2",
    description: "UI Designer — design visuel & tokens",
  },

  techwriter: {
    promptFile: "technical-writer",
    model: process.env.MODEL_FAST || "composer-2",
    description: "Rédaction technique — guides & doc utilisateur",
  },

  privacy: {
    promptFile: "privacy-by-design",
    model: process.env.MODEL_STRONG || "gpt-5-mini",
    description: "Privacy by design — données & conformité produit",
  },
} as const;

type AgentRole = keyof typeof AGENT_CONFIG;

type PipelineStep = "pm" | "architect" | "dev" | "qa" | "redteam";
const PIPELINE_STEPS: PipelineStep[] = ["pm", "architect", "dev", "qa", "redteam"];

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
        "   Passe --project projects/<fichier>.md (frontmatter avec `repo`) ou définit TARGET_REPO_URL dans .env."
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
  } = {}
) {
  const config = AGENT_CONFIG[role];
  const prompt = loadPrompt(config.promptFile);

  console.log(`\n🚀 Lancement de l'agent : ${config.description}`);
  console.log(`   Modèle : ${config.model}`);
  console.log(`   Mode : ${options.cloud ? "☁️  Cloud" : "💻 Local"}`);
  console.log(`   Tâche : ${task.substring(0, 80)}...`);
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
    model: { id: config.model },
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

  const agent = await Agent.create(agentOptions);
  const roleAndTask = `${prompt}\n\n---\n\n${fullTask}`;
  const taskWithSystemPrompt = projectSection ? `${projectSection}\n\n---\n\n${roleAndTask}` : roleAndTask;
  const run = await agent.send(taskWithSystemPrompt);

  // Attendre la fin et afficher le résultat
  const runResult = await run.wait();
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

// Détecte si QA approuve ou demande des changements
function detectQAVerdict(qaReport: string): "APPROVE" | "REQUEST_CHANGES" {
  const lowerReport = qaReport.toLowerCase();
  if (lowerReport.includes("request changes") || lowerReport.includes("request_changes")) {
    return "REQUEST_CHANGES";
  }
  return "APPROVE";
}

// Détecte si la red team a des vulnérabilités critiques/majeures
function detectSecurityVerdict(securityReport: string): "APPROVED" | "CRITICAL_ISSUES" | "MEDIUM_ISSUES" {
  const lowerReport = securityReport.toLowerCase();
  if (lowerReport.includes("🚨 vulnérabilités critiques") || lowerReport.includes("vulnérabilités critiques")) {
    return "CRITICAL_ISSUES";
  }
  if (lowerReport.includes("⚠️ vulnérabilités moyennes") || lowerReport.includes("vulnérabilités moyennes")) {
    return "MEDIUM_ISSUES";
  }
  return "APPROVED";
}

// Backlog management functions
function loadBacklog(): Backlog {
  if (!existsSync(BACKLOG_PATH)) {
    return { version: 1, lastUpdated: new Date().toISOString(), issues: [] };
  }
  return JSON.parse(readFileSync(BACKLOG_PATH, "utf-8")) as Backlog;
}

function saveBacklog(backlog: Backlog): void {
  backlog.lastUpdated = new Date().toISOString();
  writeFileSync(BACKLOG_PATH, JSON.stringify(backlog, null, 2), "utf-8");
}

function parsePMOutput(pmOutput: string): Omit<BacklogIssue, "id" | "createdAt" | "updatedAt" | "completedAt" | "pipelineRun">[] {
  const issues: Omit<BacklogIssue, "id" | "createdAt" | "updatedAt" | "completedAt" | "pipelineRun">[] = [];
  const blocks = pmOutput
    .split(/\n(?:---+|\*\*\*+)\n/)
    .filter(b => b.includes("🎯 User Story") || b.includes("User Story"));

  for (const block of blocks) {
    // Try to extract title from # heading first
    const h1Match = block.match(/^#\s+(.+?)$/m);
    let title = h1Match ? h1Match[1].trim() : null;

    // If no h1, try to extract from "je veux X afin de" pattern, handling multiline
    if (!title) {
      const userStoryMatch = block.match(/je\s+veux\s+(.+?)\s+(?:afin|pour)\s+de/is);
      title = userStoryMatch ? userStoryMatch[1].trim().split('\n')[0] : null;
    }

    // Fallback
    title = title || "Issue sans titre";

    const priorityMatch = block.match(/## [🏷️\s]*Priorit[ée][^\n]*\n+\[?(MUST|SHOULD|COULD|WONT)\]?/i);
    const priority = (priorityMatch?.[1]?.toUpperCase() ?? "SHOULD") as IssuePriority;

    const sizeMatch = block.match(/## [📏\s]*Taille[^\n]*\n+\[?(S|M|L|XL)\]?/i);
    const size = (sizeMatch?.[1]?.toUpperCase() ?? "M") as IssueSize;

    issues.push({ title, description: block.trim(), status: "todo", priority, size });
  }

  return issues;
}

function generateIssueId(backlog: Backlog): string {
  const maxNum = backlog.issues
    .map(i => parseInt(i.id.replace("issue-", ""), 10))
    .filter(n => !isNaN(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `issue-${String(maxNum + 1).padStart(3, "0")}`;
}

const PRIORITY_ORDER: Record<IssuePriority, number> = { MUST: 0, SHOULD: 1, COULD: 2, WONT: 3 };
const SIZE_ORDER: Record<IssueSize, number> = { S: 0, M: 1, L: 2, XL: 3 };

function pickNextIssue(backlog: Backlog): BacklogIssue | null {
  const candidates = backlog.issues
    .filter(i => i.status === "todo" && i.priority !== "WONT")
    .sort((a, b) => {
      const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pd !== 0) return pd;
      return SIZE_ORDER[a.size] - SIZE_ORDER[b.size];
    });
  return candidates[0] ?? null;
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
        "   Utilise --project avec un fichier contenant `repo:` ou définis TARGET_REPO_URL dans .env."
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
  issue.pipelineRun = new Date().toISOString();
  saveBacklog(backlog);

  try {
    await fullPipeline(issue.description);

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
 */
async function fullPipeline(brief: string, opts: { resumeFrom?: PipelineStep } = {}) {
  const resumeFrom = opts.resumeFrom ?? "pm";
  const startIdx = PIPELINE_STEPS.indexOf(resumeFrom);

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
    specs = await runAgent("pm", brief);
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
      { additionalContext: specs }
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
        { additionalContext: devContext, cloud: true, autoCreatePR: true }
      )
    : brief; // si on reprend depuis QA ou redteam, le brief est le contexte de l'implémentation

  // Boucle QA avec feedback
  let qaApproved = startIdx > 3; // si on reprend depuis redteam, QA est déjà passé
  let qaIteration = 0;
  const maxQAIterations = 3;
  let qaReport = "";

  if (startIdx > 3) {
    console.log("\n🧪 ÉTAPE 4/5 — QA Engineer : ⏭  ignoré (--resume-from)");
  } else {
    while (!qaApproved && qaIteration < maxQAIterations) {
      qaIteration++;
      console.log(`\n🧪 ÉTAPE 4/${maxQAIterations} — QA Engineer (itération ${qaIteration})`);

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
          }
        );
      } else {
        console.log("⚠️  QA N'A PAS APPROUVÉ APRÈS 3 ITÉRATIONS — Passage malgré tout (escalade manuelle recommandée).\n");
        qaApproved = true;
      }
    }
  }

  // ── Étape 5 : Red Team avec boucle feedback ──
  let securityApproved = false;
  let rtIteration = 0;
  const maxRTIterations = 3;
  let securityReport = "";

  while (!securityApproved && rtIteration < maxRTIterations) {
    rtIteration++;
    console.log(`\n🔴 ÉTAPE 5/${maxRTIterations} — Red Team (itération ${rtIteration})`);

    const rtPrompt = rtIteration === 1
      ? "Audite le code de la PR pour les vulnérabilités de sécurité."
      : `Re-audite la PR après les corrections du développeur.\n\nVoici le rapport précédent de la red team :\n${securityReport}\n\nVérifie si les problèmes identifiés ont été correctement adressés.`;

    securityReport = await runAgent(
      "redteam",
      rtPrompt,
      {
        additionalContext: implementation,
        cloud: true,
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
        }
      );
    } else if (securityVerdict === "MEDIUM_ISSUES") {
      securityApproved = true;
      console.log("⚠️  VULNÉRABILITÉS MOYENNES IDENTIFIÉES — Passage avec documentation.\n");
      console.log("   Note : Les vulnérabilités moyennes doivent être traitées dans les sprints suivants.\n");
    } else {
      console.log("⚠️  AUDIT DE SÉCURITÉ N'A PAS APPROUVÉ APRÈS 3 ITÉRATIONS — Passage malgré tout (escalade manuelle recommandée).\n");
      securityApproved = true;
    }
  }

  // ── Résumé final ──
  const skipped = (step: PipelineStep) => PIPELINE_STEPS.indexOf(step) < startIdx;
  console.log("\n" + "═".repeat(60));
  console.log("📊 PIPELINE TERMINÉ — Résumé");
  console.log("═".repeat(60));
  console.log(`1. Specs PM          : ${skipped("pm") ? "⏭  ignoré" : "✅ rédigées"}`);
  console.log(`2. Architecture      : ${skipped("architect") ? "⏭  ignoré" : "✅ conçue"}`);
  console.log(`3. Implémentation    : ${skipped("dev") ? "⏭  ignoré" : "✅ PR créée"}`);
  console.log(`4. Review QA         : ${skipped("qa") ? "⏭  ignoré" : `✅ approuvée (${qaIteration} itération${qaIteration > 1 ? "s" : ""})`}`);
  console.log(`5. Audit sécurité    : ✅ complété (${rtIteration} itération${rtIteration > 1 ? "s" : ""})`);
  console.log("\n👉 Va sur GitHub pour review final et merger la PR.");
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
    const briefFilePath = resolve(process.cwd(), args[briefFileFlag + 1]);
    // LFI guard : refuser tout chemin qui sort du répertoire courant
    if (!briefFilePath.startsWith(resolve(process.cwd()) + "/")) {
      console.error(
        "❌ --brief-file : chemin non autorisé.\n" +
        "   Seuls les fichiers dans le dossier courant sont acceptés."
      );
      process.exit(1);
    }
    if (!existsSync(briefFilePath)) {
      console.error(`❌ --brief-file : fichier introuvable : ${briefFilePath}`);
      process.exit(1);
    }
    briefFromFile = readFileSync(briefFilePath, "utf-8").trim();
    console.log(`📄 Brief chargé depuis : ${args[briefFileFlag + 1]}`);
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

    // Use cloud mode for direct agent invocation
    await runAgent(role, task, { cloud: true });
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
