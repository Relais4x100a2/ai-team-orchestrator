/**
 * ============================================================
 * AI Team Orchestrator — Cerveau de l'équipe de dev IA
 * ============================================================
 *
 * Ce script orchestre les différents agents (PM, architecte, dev, QA, red team)
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

import { Agent } from "@cursor/sdk";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Charge un fichier prompt depuis src/prompts/ */
function loadPrompt(role: string): string {
  const path = resolve(__dirname, "prompts", `${role}.md`);
  if (!existsSync(path)) {
    throw new Error(`Prompt introuvable : ${path}`);
  }
  return readFileSync(path, "utf-8");
}

/** Configuration des agents — modifie les modèles ici si besoin */
const AGENT_CONFIG = {
  // Le PM utilise un modèle puissant car il doit bien comprendre le contexte
  pm: {
    promptFile: "product-manager",
    model: process.env.MODEL_STRONG || "claude-sonnet-4-20250514",
    description: "Product Manager — specs & backlog",
  },

  // L'architecte a besoin de raisonnement complexe
  architect: {
    promptFile: "data-architect",
    model: process.env.MODEL_STRONG || "claude-sonnet-4-20250514",
    description: "Data Architect — modèle de données & architecture",
  },

  // L'UX designer peut utiliser un modèle plus léger
  ux: {
    promptFile: "ux-designer",
    model: process.env.MODEL_FAST || "composer-2",
    description: "UX Designer — parcours utilisateur & wireframes",
  },

  // Le dev full-stack utilise Composer 2 (optimisé pour le code)
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

  // La red team a besoin d'un modèle puissant pour l'analyse de sécurité
  redteam: {
    promptFile: "red-team",
    model: process.env.MODEL_STRONG || "claude-sonnet-4-20250514",
    description: "Red Team — audit de sécurité",
  },
} as const;

type AgentRole = keyof typeof AGENT_CONFIG;

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

  // Création de l'agent
  const agentOptions: Parameters<typeof Agent.create>[0] = {
    apiKey: process.env.CURSOR_API_KEY!,
    model: { id: config.model },
    systemPrompt: prompt,
  };

  // Mode cloud ou local
  if (options.cloud) {
    Object.assign(agentOptions, {
      cloud: {
        repos: [
          {
            url: process.env.TARGET_REPO_URL!,
            startingRef: process.env.TARGET_BRANCH || "main",
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
  const run = await agent.send(fullTask);

  // Stream des événements (tu vois le travail en temps réel)
  let result = "";
  for await (const event of run.stream()) {
    if (typeof event === "string") {
      process.stdout.write(event);
      result += event;
    } else if (event.type === "text") {
      process.stdout.write(event.content);
      result += event.content;
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`✅ Agent ${role} terminé.\n`);

  return result;
}

// ------------------------------------------------------------
// Pipelines
// ------------------------------------------------------------

/**
 * Pipeline complet : PM → Architecte → Dev → QA → Red Team
 *
 * C'est le workflow principal. Chaque agent reçoit le contexte
 * des agents précédents. Entre chaque étape, le super-superviseur
 * (toi) peut intervenir via les hooks Cursor.
 */
async function fullPipeline(brief: string) {
  console.log("═".repeat(60));
  console.log("🏗️  PIPELINE COMPLET — Du brief au déploiement");
  console.log("═".repeat(60));

  // ── Étape 1 : Product Manager ──
  console.log("\n📋 ÉTAPE 1/5 — Product Manager");
  const specs = await runAgent("pm", brief);

  // 🛑 CHECKPOINT — Le super-superviseur review les specs
  // En production, ici tu aurais un hook qui attend ta validation
  // Pour l'instant, on continue automatiquement
  console.log("⏸️  CHECKPOINT : Review les specs ci-dessus.");
  console.log("   En production, le pipeline s'arrête ici pour ta validation.\n");

  // ── Étape 2 : Data Architect ──
  console.log("\n🏛️  ÉTAPE 2/5 — Data Architect");
  const architecture = await runAgent(
    "architect",
    "Conçois l'architecture technique et le modèle de données pour les specs suivantes.",
    { additionalContext: specs }
  );

  // 🛑 CHECKPOINT
  console.log("⏸️  CHECKPOINT : Review l'architecture ci-dessus.\n");

  // ── Étape 3 : Développeur Full-Stack ──
  console.log("\n💻 ÉTAPE 3/5 — Développeur Full-Stack");
  const implementation = await runAgent(
    "dev",
    "Implémente les fonctionnalités selon les specs et l'architecture ci-dessous. Crée une branche feature/ et ouvre une PR.",
    {
      additionalContext: `## Specs PM\n${specs}\n\n## Architecture\n${architecture}`,
      cloud: true,
      autoCreatePR: true,
    }
  );

  // ── Étape 4 : QA Engineer ──
  console.log("\n🧪 ÉTAPE 4/5 — QA Engineer");
  const qaReport = await runAgent(
    "qa",
    "Review la PR créée par le développeur. Vérifie le code, les tests, et la conformité aux specs.",
    {
      additionalContext: `## Specs PM\n${specs}\n\n## Implémentation\n${implementation}`,
      cloud: true,
    }
  );

  // ── Étape 5 : Red Team ──
  console.log("\n🔴 ÉTAPE 5/5 — Red Team");
  const securityReport = await runAgent(
    "redteam",
    "Audite le code de la PR pour les vulnérabilités de sécurité.",
    {
      additionalContext: implementation,
      cloud: true,
    }
  );

  // ── Résumé final ──
  console.log("\n" + "═".repeat(60));
  console.log("📊 PIPELINE TERMINÉ — Résumé");
  console.log("═".repeat(60));
  console.log("1. Specs PM        : ✅ rédigées");
  console.log("2. Architecture    : ✅ conçue");
  console.log("3. Implémentation  : ✅ PR créée");
  console.log("4. Review QA       : ✅ rapport produit");
  console.log("5. Audit sécurité  : ✅ rapport produit");
  console.log("\n👉 Va sur GitHub pour review et merger la PR.");
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
  const roleFlag = args.indexOf("--role");
  const pipelineFlag = args.indexOf("--pipeline");

  if (roleFlag !== -1 && args[roleFlag + 1]) {
    // Mode agent unique : npm run agent:pm "Ma tâche"
    const role = args[roleFlag + 1] as AgentRole;
    const task = args.slice(roleFlag + 2).join(" ") || "Analyse le projet et propose des améliorations.";

    if (!(role in AGENT_CONFIG)) {
      console.error(`❌ Rôle inconnu : ${role}`);
      console.error(`   Rôles disponibles : ${Object.keys(AGENT_CONFIG).join(", ")}`);
      process.exit(1);
    }

    await runAgent(role, task);
  } else if (pipelineFlag !== -1) {
    // Mode pipeline : npm run pipeline "Mon brief"
    const brief = args.slice(pipelineFlag + 1).join(" ")
      || "Analyse le projet existant et propose des améliorations.";

    await fullPipeline(brief);
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
