import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { IssueSize } from "../backlog.js";
import { generateIssueId, parsePMOutput } from "../backlog.js";
import { checkFrugalMode } from "../spend-guard.js";
import { previewText, REPO_ROOT } from "./paths-and-env.js";
import { loadBacklog, saveBacklog, printBacklogSummary } from "./backlog-io.js";
import { runAgent, resolveCloudMode } from "./agent-runner.js";
import { migrateLegacySecurityFile, resolveLastRunDir } from "./run-context.js";
import type { OrchestratorSession } from "./session.js";

/** Sauvegarde la sortie PM quand parsePMOutput ne peut pas être appliqué (diagnostic hors backlog.json). */
function savePmParseFailureArtifacts(
  session: OrchestratorSession,
  pmOutput: string,
  extras?: { architecture?: string; reflection?: string },
): void {
  try {
    if (session.activeProjectSlug) {
      const dir = resolveLastRunDir(session);
      mkdirSync(dir, { recursive: true });
      migrateLegacySecurityFile(dir);
      const basePath = resolve(dir, "pm-parse-failure");
      writeFileSync(`${basePath}.raw.md`, pmOutput, "utf-8");
      if (extras?.architecture?.trim()) {
        writeFileSync(`${basePath}.architecture.md`, extras.architecture, "utf-8");
      }
      if (extras?.reflection?.trim()) {
        writeFileSync(`${basePath}.reflection.md`, extras.reflection, "utf-8");
      }
      console.log(
        `   📝 Sortie brute (parse PM) : last-run/${session.activeProjectSlug}/pm-parse-failure.*.md`,
      );
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

export async function pipelineBacklogReflection(
  session: OrchestratorSession,
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
  const pmTask =
    direction === "forward"
      ? "À partir de cette métavision, génère/structure des user stories backlog actionnables avec priorités, tailles et critères d'acceptation."
      : "À partir de ce feedback terrain, révise et complète le backlog en ajustant priorités, tailles et critères d'acceptation.";
  const specs = await runAgent(session, "pm", pmTask, {
    additionalContext: brief,
    frugal,
    cloud: resolveCloudMode(session, "pm"),
  });

  const architecture = await runArchitectForBacklogReflection(session, specs, frugal);

  const reflection = await runAgent(
    session,
    "redteam_reflection",
    "Challenge la cohérence produit/architecture et propose les ajustements backlog nécessaires.",
    {
      additionalContext: `## Backlog\n${specs}\n\n## Vision architecture\n${architecture}`,
      frugal,
      cloud: resolveCloudMode(session, "redteam_reflection"),
    },
  );

  const parsedIssues = parsePMOutput(specs);
  if (parsedIssues.length === 0) {
    console.log("⚠️  Aucune issue parsée depuis la sortie PM — backlog non modifié.");
    savePmParseFailureArtifacts(session, specs, {
      architecture,
      reflection,
    });
    return;
  }

  const backlog = loadBacklog(session);
  const now = new Date().toISOString();
  const architectureSummary = previewText(architecture, 500);
  const reflectionSummary = previewText(reflection, 500);

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
  console.log(`\n✅ Backlog mis à jour via pipeline backlog ${direction} (${parsedIssues.length} item(s) traités).`);
  printBacklogSummary(session, backlog);
}
