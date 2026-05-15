import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { Backlog, IssueSize } from "../backlog.js";
import { generateIssueId, parsePMOutput } from "../backlog.js";
import { checkFrugalMode } from "../spend-guard.js";
import { createSprint, loadSprintIndex, updateSprintIssueCount } from "./sprint-io.js";
import {
  extractHandoffSection,
  formatDataDirPath,
  mkdirWithDefaultGitignoreIfNeeded,
  previewText,
  REPO_ROOT,
  warnIfHandoffFallback,
} from "./paths-and-env.js";
import { formatBacklogForContext, loadBacklog, saveBacklog, printBacklogSummary } from "./backlog-io.js";
import { runAgent, resolveCloudMode } from "./agent-runner.js";
import { migrateLegacySecurityFile, resolveLastRunDir } from "./run-context.js";
import type { OrchestratorSession } from "./session.js";
import { ANSWER_PREFIX, extractOpenQuestions, promptOpenQuestions } from "./open-questions.js";
import { buildCodeSnapshot } from "./code-snapshot.js";

/** Sauvegarde la sortie PM quand parsePMOutput ne peut pas être appliqué (diagnostic hors backlog.json). */
function savePmParseFailureArtifacts(
  session: OrchestratorSession,
  pmOutput: string,
  extras?: { architecture?: string; reflection?: string },
): void {
  try {
    if (session.activeProjectSlug) {
      const dir = resolveLastRunDir(session);
      mkdirWithDefaultGitignoreIfNeeded(dir);
      if (!session.activeProject?.projectDataDir) {
        migrateLegacySecurityFile(dir);
      }
      const basePath = resolve(dir, "pm-parse-failure");
      writeFileSync(`${basePath}.raw.md`, pmOutput, "utf-8");
      if (extras?.architecture?.trim()) {
        writeFileSync(`${basePath}.architecture.md`, extras.architecture, "utf-8");
      }
      if (extras?.reflection?.trim()) {
        writeFileSync(`${basePath}.reflection.md`, extras.reflection, "utf-8");
      }
      console.log(`   📝 Sortie brute (parse PM) : ${formatDataDirPath(basePath)}.*.md`);
    } else {
      const fallback = "backlog-raw.md";
      writeFileSync(resolve(REPO_ROOT, fallback), pmOutput, "utf-8");
      console.log(`   📝 Sortie brute (parse PM) : ${fallback} (racine orchestrateur)`);
    }
  } catch (e) {
    console.warn(`   ⚠️  Échec sauvegarde diagnostic parse PM : ${(e as Error).message}`);
  }
}

export async function runArchitectForBacklogReflection(
  session: OrchestratorSession,
  specs: string,
  frugal: boolean,
  issueSize?: IssueSize,
): Promise<string> {
  return runAgent(
    session,
    "architect",
    "Produit la vision cible pour les items Must/Should du backlog (cible, hypothèses/contraintes, alternative crédible, risques principaux).",
    { additionalContext: specs, frugal, issueSize, cloud: resolveCloudMode(session, "architect") },
  );
}

export async function pmBacklogWorkflow(session: OrchestratorSession): Promise<void> {
  console.log("═".repeat(60));
  console.log("📋 PM BACKLOG — Analyse du repo et génération du backlog");
  console.log("═".repeat(60));

  const repoUrl = session.activeProject?.repo?.trim() || process.env.TARGET_REPO_URL?.trim();
  if (!repoUrl) {
    console.error(
      "❌ PM backlog (mode cloud) : dépôt cible inconnu.\n" +
        "   Utilise --project projects/<fichier>.md (frontmatter avec `repo:`).",
    );
    process.exit(1);
  }

  const pmTask = `Analyse le repo ${repoUrl} et produis la liste complète des issues prioritaires à implémenter. Pour CHAQUE issue, utilise EXACTEMENT le format défini (## 🎯 User Story, ## 🏷️ Priorité, ## 📏 Taille estimée, etc.). Sépare chaque issue par une ligne "---".`;

  const pmOutput = await runAgent(session, "pm", pmTask, { cloud: resolveCloudMode(session, "pm") });
  const parsedIssues = parsePMOutput(pmOutput);

  if (parsedIssues.length === 0) {
    console.log("⚠️  Aucune issue parsée depuis la sortie du PM. Vérifie le format de sortie.");
    savePmParseFailureArtifacts(session, pmOutput);
    return;
  }

  const backlog = loadBacklog(session);
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

  saveBacklog(session, backlog);
  console.log(`\n✅ ${parsedIssues.length} issue(s) ajoutées à backlog.json`);
  printBacklogSummary(session, backlog);
}

/**
 * Si la sortie contient des questions ouvertes et que stdin est interactif,
 * pause et collecte les réponses. Retourne une chaîne à préfixer dans additionalContext.
 */
async function collectOpenAnswers(agentOutput: string): Promise<string> {
  const questions = extractOpenQuestions(agentOutput);
  if (questions.length === 0 || !process.stdin.isTTY) {
    if (questions.length > 0) {
      console.warn(`\n⚠️  ${questions.length} question(s) ouverte(s) détectée(s) — mode non-interactif, ignorée(s).`);
    }
    return "";
  }
  console.log(`\n💬 ${questions.length} question(s) ouverte(s) de l'agent — répondre pour affiner l'étape suivante.`);
  const collected = await promptOpenQuestions(questions);
  // Discard if user provided only empty answers
  const hasContent = collected
    .split("\n")
    .filter((l) => l.startsWith(ANSWER_PREFIX))
    .some((l) => l.replace(ANSWER_PREFIX, "").trim().length > 0);
  return hasContent ? collected : "";
}

export async function pipelineBacklogReflection(
  session: OrchestratorSession,
  direction: "forward" | "backward",
  brief: string,
  fromSprintId?: string,
): Promise<void> {
  const source = direction === "forward" ? "top_down" : "bottom_up";
  const label = direction === "forward" ? "métavision (top-down)" : "feedback (bottom-up)";
  console.log("═".repeat(60));
  console.log(`🧭 PIPELINE BACKLOG (${direction}) — Réflexion -> Backlog`);
  console.log("═".repeat(60));
  console.log(`   Source attendue : ${label}`);

  let backlogContext = "";
  if (fromSprintId && session.activeProject?.projectDataDir) {
    const sourcePath = resolve(
      session.activeProject.projectDataDir,
      "sprints",
      fromSprintId,
      "backlog.json",
    );
    if (existsSync(sourcePath)) {
      try {
        const sourceBacklog = JSON.parse(readFileSync(sourcePath, "utf-8")) as Backlog;
        backlogContext = formatBacklogForContext(sourceBacklog);
        console.log(`   🔗 Continuité depuis sprint : ${fromSprintId}`);
      } catch {
        console.warn(`   ⚠️  Sprint source : lecture échouée — démarrage sans contexte.`);
      }
    } else {
      console.warn(`   ⚠️  Sprint source introuvable : ${fromSprintId} — démarrage sans contexte.`);
    }
  }

  // Créer un sprint si projectDataDir est disponible
  if (session.activeProject?.projectDataDir) {
    const sprintId = createSprint(session.activeProject.projectDataDir, direction, brief, fromSprintId);
    session.activeSprintId = sprintId;
    session.agentOutputRelativeSubdir = `sprints/${sprintId}`;
    console.log(`   📁 Sprint : ${sprintId}`);
  }

  const frugal = await checkFrugalMode(process.env);

  const codeSnapshot = session.activeProject?.localPath
    ? buildCodeSnapshot(session.activeProject.localPath, session.activeProject.projectDataDir ?? undefined)
    : "";

  const withSnapshot = (ctx: string): string => {
    const parts: string[] = [];
    if (backlogContext) parts.push(backlogContext);
    if (codeSnapshot) parts.push(`## Contexte code du projet\n\n${codeSnapshot}`);
    parts.push(ctx);
    return parts.join("\n\n---\n\n");
  };

  const pmTask =
    direction === "forward"
      ? "À partir de cette métavision, génère/structure des user stories backlog actionnables avec priorités, tailles et critères d'acceptation."
      : "À partir de ce feedback terrain, révise et complète le backlog en ajustant priorités, tailles et critères d'acceptation.";
  const specs = await runAgent(session, "pm", pmTask, {
    additionalContext: withSnapshot(brief),
    frugal,
    cloud: resolveCloudMode(session, "pm"),
  });

  const pmAnswers = await collectOpenAnswers(specs);
  const specsWithAnswers = pmAnswers ? `${pmAnswers}\n\n---\n\n${specs}` : specs;

  const architecture = await runArchitectForBacklogReflection(session, withSnapshot(specsWithAnswers), frugal);

  const archAnswers = await collectOpenAnswers(architecture);
  const architectureWithAnswers = archAnswers ? `${archAnswers}\n\n---\n\n${architecture}` : architecture;

  const reflection = await runAgent(
    session,
    "redteam_reflection",
    "Challenge la cohérence produit/architecture et propose les ajustements backlog nécessaires.",
    {
      additionalContext: withSnapshot(`## Backlog\n${specsWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}`),
      frugal,
      cloud: resolveCloudMode(session, "redteam_reflection"),
    },
  );

  const reflectionAnswers = await collectOpenAnswers(reflection);
  const reflectionWithAnswers = reflectionAnswers ? `${reflectionAnswers}\n\n---\n\n${reflection}` : reflection;

  const pmSynthesisTask =
    "À partir de la vision PM initiale, des contraintes architecture et des défis red team, produis la version FINALE et révisée du backlog. Intègre les ajustements de priorité, taille et description proposés. Utilise EXACTEMENT le même format (## 🎯 User Story, ## 🏷️ Priorité, ## 📏 Taille estimée, etc.) séparé par ---.";
  const specsFinal = await runAgent(session, "pm", pmSynthesisTask, {
    additionalContext: withSnapshot(`## Backlog initial (PM)\n${specsWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}\n\n## Défis et ajustements Red Team\n${reflectionWithAnswers}`),
    frugal,
    cloud: resolveCloudMode(session, "pm"),
  });

  const parsedIssues = parsePMOutput(specsFinal);
  if (parsedIssues.length === 0) {
    console.log("⚠️  Aucune issue parsée depuis la sortie PM (synthèse finale) — backlog non modifié.");
    savePmParseFailureArtifacts(session, specsFinal, {
      architecture: architectureWithAnswers,
      reflection: reflectionWithAnswers,
    });
    return;
  }

  const backlog = loadBacklog(session);
  const now = new Date().toISOString();
  const archSummaryExtract = extractHandoffSection(architecture, "## Handoff Dev — Architecture");
  warnIfHandoffFallback("Vision architecture (→ backlog.json)", architecture, "## Handoff Dev — Architecture", archSummaryExtract);
  const architectureSummary = archSummaryExtract || previewText(architecture, 500);

  const reflectionSummaryExtract = extractHandoffSection(reflection, "## Handoff Dev — Produit");
  warnIfHandoffFallback("Red team réflexion (→ backlog.json)", reflection, "## Handoff Dev — Produit", reflectionSummaryExtract);
  const reflectionSummary = reflectionSummaryExtract || previewText(reflection, 500);

  for (const parsed of parsedIssues) {
    const existing = backlog.issues.find((i) => i.title.trim().toLowerCase() === parsed.title.trim().toLowerCase());
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
      architectureVision:
        parsed.priority === "MUST" || parsed.priority === "SHOULD" ? architectureSummary : undefined,
      reflectionChallenge:
        parsed.priority === "MUST" || parsed.priority === "SHOULD" ? reflectionSummary : undefined,
    });
  }

  saveBacklog(session, backlog);
  if (session.activeProject?.projectDataDir && session.activeSprintId) {
    updateSprintIssueCount(session.activeProject.projectDataDir, session.activeSprintId, parsedIssues.length);
  }
  console.log(`\n✅ Backlog mis à jour via pipeline backlog ${direction} (${parsedIssues.length} item(s) traités).`);
  printBacklogSummary(session, backlog);
}
