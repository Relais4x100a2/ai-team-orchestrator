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
  if (fromSprintId !== undefined && session.activeProject?.projectDataDir) {
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
      } catch (e) {
        console.warn(`   ⚠️  Sprint source : lecture échouée — démarrage sans contexte. (${(e as Error).message})`);
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

  const withSnapshot = (ctx: string, includeCarryover = false): string => {
    const parts: string[] = [];
    if (includeCarryover && backlogContext) parts.push(backlogContext);
    if (codeSnapshot) parts.push(`## Contexte code du projet\n\n${codeSnapshot}`);
    parts.push(ctx);
    return parts.join("\n\n---\n\n");
  };

  // ── Étape 1 : PO (vision métier + signal INCLUDE_UX_UI) ──────────────────
  const poTask =
    direction === "forward"
      ? "À partir de cette métavision, produis la vision métier et les besoins priorisés avec critères d'acceptation utilisateur. Évalue si le sprint nécessite un travail UX/UI."
      : "À partir de ce feedback terrain, identifie les ajustements de valeur métier et priorisation nécessaires. Évalue si le sprint nécessite un travail UX/UI.";
  const poOutput = await runAgent(session, "po", poTask, {
    additionalContext: withSnapshot(brief, true),
    frugal,
    cloud: resolveCloudMode(session, "po"),
  });

  const poAnswers = await collectOpenAnswers(poOutput);
  const poOutputWithAnswers = poAnswers ? `${poAnswers}\n\n---\n\n${poOutput}` : poOutput;

  // Parse du signal INCLUDE_UX_UI
  const includeUxUiMatch = /INCLUDE_UX_UI:\s*(true|false)/i.exec(poOutput);
  if (!includeUxUiMatch) {
    console.warn("   ⚠️  Signal INCLUDE_UX_UI absent de la sortie PO — UX/UI non invoqués par défaut.");
  }
  const includeUxUi = includeUxUiMatch?.[1]?.toLowerCase() === "true";
  console.log(`   🎨 UX/UI dans ce sprint : ${includeUxUi ? "oui" : "non"}`);

  // ── Étape 2 : Architect + UX/UI optionnels (parallèle) ───────────────────
  const parallelTasks: Promise<string>[] = [
    runArchitectForBacklogReflection(session, withSnapshot(poOutputWithAnswers), frugal),
  ];

  if (includeUxUi) {
    console.log("   🎨 Lancement UX + UI en parallèle avec Architect…");
    parallelTasks.push(
      runAgent(
        session,
        "ux",
        "À partir de la vision PO, propose les parcours utilisateur et wireframes clés pour ce sprint.",
        {
          additionalContext: withSnapshot(poOutputWithAnswers),
          frugal,
          cloud: resolveCloudMode(session, "ux"),
        },
      ),
      runAgent(
        session,
        "ui",
        "À partir de la vision PO, propose les composants visuels et tokens UI nécessaires pour ce sprint.",
        {
          additionalContext: withSnapshot(poOutputWithAnswers),
          frugal,
          cloud: resolveCloudMode(session, "ui"),
        },
      ),
    );
  }

  const parallelResults = await Promise.all(parallelTasks);
  const architecture = parallelResults[0]!;
  const uxOutput = includeUxUi ? (parallelResults[1] ?? "") : "";
  const uiOutput = includeUxUi ? (parallelResults[2] ?? "") : "";

  if (includeUxUi) {
    if (!uxOutput) console.warn("   ⚠️  Agent UX — sortie vide, ignorée.");
    if (!uiOutput) console.warn("   ⚠️  Agent UI — sortie vide, ignorée.");
  }

  const archAnswers = await collectOpenAnswers(architecture);
  const architectureWithAnswers = archAnswers ? `${archAnswers}\n\n---\n\n${architecture}` : architecture;

  // ── Étape 3 : Red Team ───────────────────────────────────────────────────
  const uxUiContext = [
    uxOutput ? `## Vision UX\n${uxOutput}` : "",
    uiOutput ? `## Vision UI\n${uiOutput}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const reflection = await runAgent(
    session,
    "redteam_reflection",
    "Challenge la cohérence produit/architecture et propose les ajustements backlog nécessaires.",
    {
      additionalContext: withSnapshot(
        `## Vision PO\n${poOutputWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}${uxUiContext ? `\n\n${uxUiContext}` : ""}`,
      ),
      frugal,
      cloud: resolveCloudMode(session, "redteam_reflection"),
    },
  );

  const reflectionAnswers = await collectOpenAnswers(reflection);
  const reflectionWithAnswers = reflectionAnswers ? `${reflectionAnswers}\n\n---\n\n${reflection}` : reflection;

  // ── Étape 4 : PM synthèse finale ─────────────────────────────────────────
  const pmSynthesisTask =
    "À partir de la vision PO, des contraintes architecture, des perspectives UX/UI et des défis red team, produis la version FINALE et révisée du backlog. Intègre les ajustements de priorité, taille et description proposés. Utilise EXACTEMENT le même format (## 🎯 User Story, ## 🏷️ Priorité, ## 📏 Taille estimée, etc.) séparé par ---.";
  const specsFinal = await runAgent(session, "pm", pmSynthesisTask, {
    additionalContext: withSnapshot(
      `## Vision PO\n${poOutputWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}${uxUiContext ? `\n\n${uxUiContext}` : ""}\n\n## Défis et ajustements Red Team\n${reflectionWithAnswers}`,
    ),
    frugal,
    cloud: resolveCloudMode(session, "pm"),
  });

  // ── Parse + persistance backlog ───────────────────────────────────────────
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

  // Log final avec compte réel et nombre de titres manquants
  const untitled = parsedIssues.filter((i) => i.title === "Issue sans titre").length;
  const untitledNote = untitled > 0 ? `, dont ${untitled} sans titre` : "";
  console.log(
    `\n✅ Backlog mis à jour via pipeline backlog ${direction} (${parsedIssues.length} item(s) traités${untitledNote}).`,
  );
  if (untitled > 0) {
    console.warn(`   ⚠️  ${untitled} issue(s) sans titre dans ce run — vérifier le format de sortie PM/PO.`);
  }
  printBacklogSummary(session, backlog);
}
