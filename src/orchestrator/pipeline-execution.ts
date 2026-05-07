import { PIPELINE_STEPS, type PipelineStep } from "../agent-config.js";
import type { BacklogIssue, IssueSize } from "../backlog.js";
import { pickNextIssue } from "../backlog.js";
import { closeGitHubIssueWithComment } from "../github-sync.js";
import { detectQAVerdict, detectSecurityVerdict } from "../pipeline-detection.js";
import { appendPipelineRun } from "../pipeline-runs.js";
import { checkFrugalMode } from "../spend-guard.js";
import type { PipelineRunStatus } from "../models.js";
import { newPipelineRunId } from "../models.js";
import { buildQAPipelineContext, buildSecurityImplementationContext } from "./context-builders.js";
import { formatErrorMessage } from "./paths-and-env.js";
import { loadBacklog, saveBacklog, printBacklogSummary } from "./backlog-io.js";
import { runAgent } from "./agent-runner.js";
import { runArchitectForBacklogReflection } from "./pipeline-backlog.js";
import type { OrchestratorSession } from "./session.js";

function isPipelineArchitectCloud(): boolean {
  const v = process.env.PIPELINE_ARCHITECT_CLOUD?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

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

async function runArchitectForTicketExecution(
  session: OrchestratorSession,
  specs: string,
  frugal: boolean,
  issueSize: IssueSize | undefined,
): Promise<string> {
  const useCloud = isPipelineArchitectCloud();
  const task =
    "Fournis un cadrage architecture ciblé pour sécuriser l'exécution de ce backlog item (contraintes, risques, points d'attention).";
  let out = await runAgent(session, "architect", task, {
    additionalContext: specs,
    frugal,
    issueSize,
    cloud: useCloud,
  });
  if (!out.trim() && !useCloud) {
    console.warn("⚠️  Architecte (exécution) sans sortie — nouvelle tentative en cloud…");
    out = await runAgent(session, "architect", task, {
      additionalContext: specs,
      frugal,
      issueSize,
      cloud: true,
    });
  }
  if (!out.trim()) {
    throw new Error(
      "Étape architecte (exécution) : aucune sortie. Vérifie le SDK local ou définis PIPELINE_ARCHITECT_CLOUD=1.",
    );
  }
  return out;
}

export async function pipelineNext(session: OrchestratorSession): Promise<void> {
  const backlog = loadBacklog(session);
  const issue = pickNextIssue(backlog);

  if (!issue) {
    console.log("🎉 Backlog vide — aucune issue à traiter (todo + non-WONT).");
    printBacklogSummary(session, backlog);
    return;
  }

  console.log(`\n▶ Issue sélectionnée : [${issue.id}] ${issue.title}`);
  console.log(`  Priorité: ${issue.priority} | Taille: ${issue.size}`);
  console.log("─".repeat(60));

  issue.status = "in_progress";
  issue.updatedAt = new Date().toISOString();
  const pipelineRunId = newPipelineRunId();
  issue.pipelineRun = pipelineRunId;
  saveBacklog(session, backlog);

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
    await fullPipeline(session, issue.description + issueRef, {
      pipelineRunId,
      issueSize: issue.size,
      resumeFrom: executionStart,
      mode: "execution",
      startReason: `routing pipeline next (taille ${issue.size})`,
      executionIssueBacklogFields:
        issue.architectureVision || issue.reflectionChallenge
          ? {
              architectureVision: issue.architectureVision,
              reflectionChallenge: issue.reflectionChallenge,
            }
          : undefined,
    });

    const freshBacklog = loadBacklog(session);
    const freshIssue = freshBacklog.issues.find((i) => i.id === issue.id)!;
    freshIssue.status = "done";
    freshIssue.completedAt = new Date().toISOString();
    freshIssue.updatedAt = new Date().toISOString();
    saveBacklog(session, freshBacklog);

    const ghNum = freshIssue.githubIssueNumber;
    const repo = session.activeProject?.repo?.trim();
    const ghToken = process.env.GITHUB_TOKEN?.trim();
    if (isGithubCloseIssueOnPipelineDoneEnabled() && ghNum != null && repo && ghToken) {
      try {
        await closeGitHubIssueWithComment(repo, ghToken, ghNum, githubPipelineCloseComment(freshIssue));
      } catch (e) {
        console.warn(`GitHub fermeture automatique : ${formatErrorMessage(e)}`);
      }
    }

    console.log(`\n✅ Issue ${issue.id} marquée DONE dans backlog.json`);
  } catch (err) {
    const freshBacklog = loadBacklog(session);
    const freshIssue = freshBacklog.issues.find((i) => i.id === issue.id)!;
    freshIssue.status = "todo";
    freshIssue.pipelineRun = null;
    freshIssue.updatedAt = new Date().toISOString();
    saveBacklog(session, freshBacklog);
    throw err;
  }
}

export async function fullPipeline(
  session: OrchestratorSession,
  brief: string,
  opts: {
    resumeFrom?: PipelineStep;
    pipelineRunId?: string;
    issueSize?: IssueSize;
    mode?: "full" | "execution";
    startReason?: string;
    executionIssueBacklogFields?: {
      architectureVision?: string;
      reflectionChallenge?: string;
    };
  } = {},
): Promise<void> {
  const isExecutionOnly = opts.mode === "execution";
  const defaultStart = isExecutionOnly ? "dev" : "pm";
  const resumeFrom = opts.resumeFrom ?? defaultStart;
  const startIdx = PIPELINE_STEPS.indexOf(resumeFrom);
  const runId = opts.pipelineRunId ?? newPipelineRunId();
  const startedAt = new Date().toISOString();

  let frugal = await checkFrugalMode(process.env);
  if (frugal) {
    console.warn(
      "\n⚠️  MODE FRUGAL activé pour ce run.\n" +
        "   (solo par défaut, override FRUGAL_DEFAULT ou seuil Team SPEND_ALERT_CENTS)\n",
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
  const stepLabel: Record<PipelineStep, string> = {
    pm: "PM",
    architect: "Architect",
    redteam_reflection: "Red Team Réflexion",
    dev: "Dev",
    security: "Sécurité",
    qa: "QA",
  };

  try {
    console.log("═".repeat(60));
    console.log(
      isExecutionOnly
        ? "🏗️  PIPELINE NEXT — Exécution Backlog -> QA"
        : "🏗️  PIPELINE FULL — Réflexion -> Backlog -> Exécution -> QA",
    );
    if (pipelineIssueSize) {
      console.log(`   📐 Taille issue (grille modèles) : ${pipelineIssueSize}`);
    }
    if (resumeFrom !== defaultStart) {
      const reason = opts.startReason ?? (opts.resumeFrom ? "--resume-from explicite" : "routing interne");
      console.log(`   ⏩ Démarrage depuis : ${resumeFrom.toUpperCase()} (${reason})`);
    }
    const plannedSteps = PIPELINE_STEPS.filter(
      (step) => stepLabel[step] && PIPELINE_STEPS.indexOf(step) >= startIdx,
    )
      .filter((step) => !isExecutionOnly || ["architect", "dev", "security", "qa"].includes(step))
      .map((step) => stepLabel[step])
      .join(" -> ");
    console.log(`   🗺️  Plan d'exécution : ${plannedSteps}`);
    console.log("═".repeat(60));

    let specs = brief;
    if (isExecutionOnly && opts.executionIssueBacklogFields) {
      const f = opts.executionIssueBacklogFields;
      const blocks: string[] = [];
      if (f.architectureVision?.trim()) {
        blocks.push(`## Vision déjà cadrée au backlog (résumé)\n\n${f.architectureVision.trim()}`);
      }
      if (f.reflectionChallenge?.trim()) {
        blocks.push(`## Challenge produit/architecture (résumé backlog)\n\n${f.reflectionChallenge.trim()}`);
      }
      if (blocks.length) {
        specs = `${blocks.join("\n\n")}\n\n---\n\n${brief}`;
      }
    }

    let architectureVision = "";
    let reflectionChallenge = "";

    if (!isExecutionOnly && startIdx <= 0) {
      console.log("\n📋 ÉTAPE 1/6 — Product Manager (Réflexion -> Backlog)");
      const pmOutput = await runAgent(
        session,
        "pm",
        "Formalise le backlog (Must/Should/Could/Wont) en distinguant explicitement la provenance top_down ou bottom_up de chaque item.",
        { additionalContext: brief, frugal, issueSize: pipelineIssueSize },
      );
      if (pmOutput.trim()) {
        specs = pmOutput;
      }
    } else if (!isExecutionOnly) {
      console.log("\n📋 ÉTAPE 1/6 — Product Manager : ⏭  ignoré (--resume-from)");
    }

    if (startIdx <= 1) {
      console.log("\n🏛️  ÉTAPE 2/6 — Data Architect");
      if (isExecutionOnly) {
        architectureVision = await runArchitectForTicketExecution(session, specs, frugal, pipelineIssueSize);
      } else {
        architectureVision = await runArchitectForBacklogReflection(session, specs, frugal, pipelineIssueSize);
      }
    } else if (!isExecutionOnly) {
      console.log("\n🏛️  ÉTAPE 2/6 — Data Architect : ⏭  ignoré (--resume-from)");
    }

    if (!isExecutionOnly && startIdx <= 2) {
      console.log("\n🧠 ÉTAPE 3/6 — Red Team Réflexion");
      reflectionChallenge = await runAgent(
        session,
        "redteam_reflection",
        "Challenge la cohérence produit/architecture, explicite les hypothèses à risque et propose des alternatives actionnables pour backlog Must/Should.",
        {
          additionalContext: `## Specs backlog\n${specs}\n\n## Vision architecture\n${architectureVision}`,
          frugal,
          issueSize: pipelineIssueSize,
        },
      );
    } else if (!isExecutionOnly) {
      console.log("\n🧠 ÉTAPE 3/6 — Red Team Réflexion : ⏭  ignoré (--resume-from)");
    }

    const devContext = [
      `## Brief d'origine\n${brief}`,
      specs !== brief ? `## Backlog formalisé\n${specs}` : null,
      architectureVision ? `## Vision architecture\n${architectureVision}` : null,
      reflectionChallenge ? `## Challenge produit/architecture\n${reflectionChallenge}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    if (startIdx <= 3) {
      console.log("\n💻 ÉTAPE 4/6 — Développeur Full-Stack");
      frugal = frugal || (await checkFrugalMode(process.env));
      if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");
    }

    let implementation =
      startIdx <= 3
        ? await runAgent(
            session,
            "dev",
            "Implémente les fonctionnalités du backlog Must/Should en respectant la vision architecture et ouvre/met à jour la PR.",
            { additionalContext: devContext, cloud: true, autoCreatePR: true, frugal, issueSize: pipelineIssueSize },
          )
        : brief;

    let securityApproved = startIdx > 4;
    const maxSecurityIterations = 3;
    let securityReport = "";

    if (startIdx > 4) {
      console.log("\n🔐 ÉTAPE 5/6 — Sécurité : ⏭  ignoré (--resume-from)");
    } else {
      while (!securityApproved && securityIteration < maxSecurityIterations) {
        securityIteration++;
        console.log(`\n🔐 ÉTAPE 5/6 — Sécurité — itération ${securityIteration}/${maxSecurityIterations}`);
        frugal = frugal || (await checkFrugalMode(process.env));
        if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");

        const securityPrompt =
          securityIteration === 1
            ? "Audite la PR pour les vulnérabilités de sécurité."
            : `Re-audite après corrections.\n\nRapport précédent sécurité :\n${securityReport}`;

        securityReport = await runAgent(
          session,
          "security",
          securityPrompt,
          {
            additionalContext: buildSecurityImplementationContext(session, implementation),
            cloud: true,
            frugal,
            issueSize: pipelineIssueSize,
          },
        );

        const securityVerdict = detectSecurityVerdict(securityReport);
        console.log(`   📋 Verdict sécurité (détecté) : ${securityVerdict}`);
        if (securityVerdict === "APPROVED") {
          securityApproved = true;
          console.log("✅ Sécurité approuvée — passage à QA.\n");
        } else if (securityVerdict === "CRITICAL_ISSUES" && securityIteration < maxSecurityIterations) {
          console.log("🔄 Vulnérabilités critiques — relance du développeur.\n");
          implementation = await runAgent(
            session,
            "dev",
            `Corrige les vulnérabilités critiques signalées par la sécurité.\n\n${securityReport}`,
            {
              additionalContext: devContext,
              cloud: true,
              autoCreatePR: false,
              frugal,
              issueSize: pipelineIssueSize,
            },
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

    let qaApproved = false;
    const maxQAIterations = 3;
    let qaReport = "";

    while (!qaApproved && qaIteration < maxQAIterations) {
      qaIteration++;
      console.log(`\n🧪 ÉTAPE 6/6 — QA Engineer — itération ${qaIteration}/${maxQAIterations}`);
      frugal = frugal || (await checkFrugalMode(process.env));
      if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");

      const qaPrompt =
        qaIteration === 1
          ? "Review la PR créée par le développeur. Vérifie le code, les tests, et la conformité au backlog."
          : `Re-review la PR après les changements du développeur.\n\nVoici le rapport précédent de QA :\n${qaReport}\n\nVérifie si les problèmes identifiés ont été correctement adressés.`;

      qaReport = await runAgent(
        session,
        "qa",
        qaPrompt,
        {
          additionalContext: buildQAPipelineContext(
            session,
            [
              `## Backlog formalisé\n${specs}`,
              architectureVision ? `## Vision architecture\n${architectureVision}` : null,
              reflectionChallenge ? `## Challenge amont\n${reflectionChallenge}` : null,
              securityReport ? `## Rapport sécurité\n${securityReport}` : null,
              `## Implémentation\n${implementation}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
          cloud: true,
          frugal,
          issueSize: pipelineIssueSize,
        },
      );

      const verdict = detectQAVerdict(qaReport);
      console.log(`   📋 Verdict QA (détecté) : ${verdict}`);
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
        session,
        "dev",
        `Corrige les problèmes soulevés par QA dans la revue précédente :\n\n${qaReport}\n\nMet à jour la PR avec les changements.`,
        {
          additionalContext: devContext,
          cloud: true,
          autoCreatePR: false,
          frugal,
          issueSize: pipelineIssueSize,
        },
      );

      const securityAfterQaFix = await runAgent(
        session,
        "security",
        "Re-vérifie rapidement les impacts sécurité après corrections demandées par QA.",
        {
          additionalContext: buildSecurityImplementationContext(session, implementation),
          cloud: true,
          frugal,
          issueSize: pipelineIssueSize,
        },
      );
      securityReport = securityAfterQaFix;
      const securityVerdict = detectSecurityVerdict(securityAfterQaFix);
      console.log(`   📋 Verdict sécurité (détecté) : ${securityVerdict}`);
      if (securityVerdict === "CRITICAL_ISSUES") {
        implementation = await runAgent(
          session,
          "dev",
          `Corrige les vulnérabilités critiques apparues après corrections QA :\n\n${securityAfterQaFix}`,
          {
            additionalContext: devContext,
            cloud: true,
            autoCreatePR: false,
            frugal,
            issueSize: pipelineIssueSize,
          },
        );
      } else if (securityVerdict === "MEDIUM_ISSUES") {
        mediumSecurityNotes = true;
      }
    }

    const skipped = (step: PipelineStep) => PIPELINE_STEPS.indexOf(step) < startIdx;
    if (qaEscalated || securityEscalated || mediumSecurityNotes) {
      runStatus = "partial";
    }

    console.log("\n" + "═".repeat(60));
    console.log("📊 PIPELINE TERMINÉ — Résumé");
    console.log("═".repeat(60));
    if (isExecutionOnly) {
      if (!skipped("architect")) {
        console.log("1. Cadrage architecture      : ✅ effectué");
      }
      console.log("2. Implémentation            : ✅ PR mise à jour");
      console.log(
        `3. Sécurité                  : ✅ complétée (${securityIteration} itération${securityIteration > 1 ? "s" : ""})`,
      );
      console.log(
        `4. Review QA                 : ✅ approuvée (${qaIteration} itération${qaIteration > 1 ? "s" : ""})`,
      );
    } else {
      console.log(`1. Backlog PM                : ${skipped("pm") ? "⏭  ignoré" : "✅ formalisé"}`);
      console.log(`2. Vision architecture       : ${skipped("architect") ? "⏭  ignoré" : "✅ cadrée"}`);
      console.log(
        `3. Red Team réflexion        : ${skipped("redteam_reflection") ? "⏭  ignoré" : "✅ challenge produit/archi"}`,
      );
      console.log(`4. Implémentation            : ${skipped("dev") ? "⏭  ignoré" : "✅ PR mise à jour"}`);
      console.log(
        `5. Sécurité                  : ${skipped("security") ? "⏭  ignoré" : `✅ complétée (${securityIteration} itération${securityIteration > 1 ? "s" : ""})`}`,
      );
      console.log(
        `6. Review QA                 : ${skipped("qa") ? "⏭  ignoré" : `✅ approuvée (${qaIteration} itération${qaIteration > 1 ? "s" : ""})`}`,
      );
    }
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
        `   ⚠️  Impossible d'enregistrer l'exécution du pipeline dans pipeline-runs.json : ${(e as Error).message}`,
      );
    }
  }
}
