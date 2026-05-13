import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import { PIPELINE_STEPS, type AgentRole, type PipelineStep } from "../agent-config.js";
import { isValidBacklogDocumentId, resolveBriefFilePath } from "../models.js";
import { checkFrugalMode } from "../spend-guard.js";
import { syncBacklogToGitHub, pullIssuesFromGitHub } from "../github-sync.js";
import { runAgent, AGENT_CONFIG, resolveCloudMode } from "./agent-runner.js";
import { enforceProjectBranchGuard } from "./branch-guard.js";
import { loadBacklog, resolveBacklogRelativePathForSync, saveBacklog, printBacklogSummary } from "./backlog-io.js";
import { loadProject, warnIfLegacyLastRunDataExists } from "./project-loader.js";
import { resolveUserPath } from "./paths-and-env.js";
import { emptyOrchestratorSession } from "./session.js";
import { pipelineNext, pipelineBacklogReflection, pmBacklogWorkflow } from "./workflows.js";

const PIPELINE_NEXT_RESUME_STEPS: PipelineStep[] = ["architect", "dev", "security", "qa"];

export async function main(): Promise<void> {
  if (!process.env.CURSOR_API_KEY) {
    console.error("❌ CURSOR_API_KEY manquante. Copie .env.example en .env et remplis-la.");
    process.exit(1);
  }

  const session = emptyOrchestratorSession();
  const args = process.argv.slice(2);

  const projectFlag = args.indexOf("--project");
  if (projectFlag !== -1) {
    let projectPath = args[projectFlag + 1];
    if (!projectPath || projectPath.startsWith("--")) {
      console.error("❌ --project nécessite un nom ou un chemin (ex. geneweb-py ou projects/geneweb-py.md).");
      process.exit(1);
    }
    if (!projectPath.includes("/") && !projectPath.endsWith(".md")) {
      projectPath = `projects/${projectPath}.md`;
    }
    session.activeProject = loadProject(projectPath);
    session.activeProjectSlug =
      basename(projectPath, ".md")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || null;
    console.log(`🎯 Projet : ${session.activeProject.name} (${session.activeProject.branch})`);
    warnIfLegacyLastRunDataExists(session.activeProjectSlug, session.activeProject.projectDataDir);
  }

  const backlogIdFlag = args.indexOf("--backlog-id");
  if (backlogIdFlag !== -1) {
    const rawId = args[backlogIdFlag + 1]?.trim();
    if (!rawId || rawId.startsWith("--")) {
      console.error("❌ --backlog-id nécessite un ULID (26 caractères).");
      process.exit(1);
    }
    if (!isValidBacklogDocumentId(rawId)) {
      console.error("❌ --backlog-id : format ULID invalide (Crockford base32, 26 caractères).");
      process.exit(1);
    }
    session.cliBacklogDocumentId = rawId;
  }

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

  await enforceProjectBranchGuard(session);

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
    const role = args[roleFlag + 1] as AgentRole;
    const taskFromCli = args.slice(roleFlag + 2).join(" ").trim();
    let task: string;
    let additionalContext: string | undefined;
    if (briefFromFile && taskFromCli) {
      task = taskFromCli;
      additionalContext = briefFromFile;
    } else {
      task = briefFromFile ?? (taskFromCli || "Analyse le projet et propose des améliorations.");
    }

    if (!(role in AGENT_CONFIG)) {
      console.error(`❌ Rôle inconnu : ${role}`);
      console.error(`   Rôles disponibles : ${Object.keys(AGENT_CONFIG).join(", ")}`);
      process.exit(1);
    }

    const frugal = await checkFrugalMode(process.env);
    await runAgent(session, role, task, { cloud: resolveCloudMode(session, role), frugal, additionalContext });
  } else if (pipelineFlag !== -1) {
    const subcommand = args[pipelineFlag + 1];
    if (subcommand === "next") {
      if (resumeFrom && !PIPELINE_NEXT_RESUME_STEPS.includes(resumeFrom)) {
        console.error(
          `❌ --resume-from avec --pipeline next : étape « ${resumeFrom} » invalide (réflexion PM/red team : utiliser --pipeline backlog).`,
        );
        console.error(`   Étapes valides : ${PIPELINE_NEXT_RESUME_STEPS.join(", ")}`);
        process.exit(1);
      }
      await pipelineNext(session, { resumeFrom });
    } else if (subcommand === "backlog") {
      const direction = args[pipelineFlag + 2];
      if (direction !== "forward" && direction !== "backward") {
        console.error("❌ --pipeline backlog attend 'forward' ou 'backward'.");
        process.exit(1);
      }
      const briefFromCli = args.slice(pipelineFlag + 3).join(" ");
      const brief = briefFromFile ?? (briefFromCli || "Structurer ou réviser le backlog selon le contexte fourni.");
      await pipelineBacklogReflection(session, direction, brief);
    } else {
      console.error("❌ --pipeline attend 'next' ou 'backlog forward|backward'.");
      process.exit(1);
    }
  } else if (args.includes("--sync-issues")) {
    if (!session.activeProject?.repo) {
      console.error("❌ --sync-issues nécessite --project avec un champ repo: dans le frontmatter.");
      process.exit(1);
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.error("❌ --sync-issues nécessite GITHUB_TOKEN dans .env.");
      process.exit(1);
    }
    const backlog = loadBacklog(session);
    const rel = resolveBacklogRelativePathForSync(session);
    const count = await syncBacklogToGitHub(backlog, session.activeProject.repo, token, {
      backlogRelativePath: rel,
    });
    if (count > 0) saveBacklog(session, backlog);
  } else if (args.includes("--pull-issues")) {
    if (!session.activeProject?.repo) {
      console.error("❌ --pull-issues nécessite --project avec un champ repo: dans le frontmatter.");
      process.exit(1);
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.error("❌ --pull-issues nécessite GITHUB_TOKEN dans .env.");
      process.exit(1);
    }
    const importNew = !args.includes("--no-import");
    const backlog = loadBacklog(session);
    console.log(`\n📥 Pull GitHub Issues → backlog.json (${session.activeProject.repo})`);
    const result = await pullIssuesFromGitHub(backlog, session.activeProject.repo, token, { importNew });
    if (result.statusClosed + result.labelsUpdated + result.imported > 0) {
      saveBacklog(session, backlog);
      console.log(`\n✅ Backlog mis à jour :`);
      if (result.statusClosed) console.log(`   ${result.statusClosed} issue(s) marquée(s) done`);
      if (result.labelsUpdated) console.log(`   ${result.labelsUpdated} issue(s) avec labels mis à jour`);
      if (result.imported) console.log(`   ${result.imported} nouvelle(s) issue(s) importée(s)`);
      if (result.conflicts) console.log(`   ⚠️  ${result.conflicts} conflit(s) ignoré(s) (in_progress)`);
    } else {
      console.log(`\n✅ Backlog déjà à jour — aucune modification.`);
      if (result.conflicts) console.log(`   ⚠️  ${result.conflicts} conflit(s) ignoré(s) (in_progress)`);
    }
  } else if (pmBacklogFlag !== -1) {
    await pmBacklogWorkflow(session);
  } else if (backlogFlag !== -1) {
    printBacklogSummary(session);
  } else {
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

  npm run pipeline:next
    → Exécute la prochaine issue backlog (architecte si M/L/XL, puis dev → sécurité ⇄ QA)

  npm run project -- monprojet --pipeline backlog forward "Méta-vision produit"
    → Lance la partie réflexion et met à jour backlog.json (top-down)

  npm run project -- monprojet --pipeline backlog backward "Feedback utilisateur/testeurs"
    → Lance la partie réflexion et révise backlog.json (bottom-up)

  npm run pm:backlog
    → PM analyse le repo et génère backlog.json avec issues prioritaires

  npm run backlog
    → Affiche l'état du backlog (todo/in_progress/done)

  npm run sync:issues -- --project projects/mon-projet.md
    → Pousse les issues backlog.json sans numéro GitHub vers GitHub Issues

  npm run pull:issues -- --project projects/mon-projet.md
    → Rapatrie les statuts/labels GitHub Issues vers backlog.json (--no-import pour ne pas importer les nouvelles)

  npm test
    → Exécute les tests unitaires (validation backlog.json côté modèle)

Options globales :
  --project <file>
    → Charge le contexte du projet depuis projects/<file>.md

  --backlog-id <ULID>
    → Vérifie que le fichier backlog.json chargé porte ce backlogDocumentId (sécurité / multi-doc futur).

  --brief-file <file>
    → Lit le brief depuis un fichier. Avec --role + tâche CLI, le fichier devient le contexte additionnel.

  --resume-from <step>
    → Avec --pipeline next uniquement : architect | dev | security | qa

Agents disponibles :
${Object.entries(AGENT_CONFIG)
  .map(([key, val]) => `  ${key.padEnd(12)} ${val.description}`)
  .join("\n")}
    `);
  }
}
