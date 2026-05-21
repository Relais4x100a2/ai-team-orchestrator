import { PIPELINE_STEPS, type PipelineStep } from "../agent-config.js";
import type { IssueSize } from "../backlog.js";
import {
  detectQAVerdict,
  detectSecurityVerdict,
  hasDefinitiveQAVerdict,
  hasDefinitiveSecurityVerdict,
  type SecurityVerdict,
} from "../pipeline-detection.js";
import { appendPipelineRun } from "../pipeline-runs.js";
import { checkFrugalMode } from "../spend-guard.js";
import type { PipelineRunStatus } from "../models.js";
import { newPipelineRunId } from "../models.js";
import { buildQAPipelineContext, buildSecurityImplementationContext } from "./context-builders.js";
import {
  extractHandoffSection,
  trimContext,
  warnIfHandoffFallback,
} from "./paths-and-env.js";
import { detectGitHubPrUrl } from "./run-context.js";
import { runAgent, resolveCloudMode } from "./agent-runner.js";
import { assertDevOutputSufficientForSecurityAndQA } from "./pipeline-dev-guards.js";
import { isPipelineArchitectCloud } from "./pipeline-github-env.js";
import type { PipelineExecutionOutcome, RunExecutionPipelineOptions } from "./pipeline-types.js";
import type { OrchestratorSession } from "./session.js";
import { isGithubMergePrOnCiOkEnabled } from "../github-pr-pipeline.js";

export function resolveRunStatus(
  qaEscalated: boolean,
  securityEscalated: boolean,
  mediumSecurityNotes: boolean,
  lastSecurityVerdict: SecurityVerdict | null,
): PipelineRunStatus {
  if (qaEscalated || securityEscalated) return "partial";
  if (mediumSecurityNotes && lastSecurityVerdict !== "APPROVED") return "partial";
  return "success";
}

const EXECUTION_STEP_LABEL: Record<"architect" | "dev" | "security" | "qa", string> = {
  architect: "Architect",
  dev: "Dev",
  security: "Sécurité",
  qa: "QA",
};

async function runArchitectForTicketExecution(
  session: OrchestratorSession,
  specs: string,
  frugal: boolean,
  issueSize: IssueSize | undefined,
  issueLabel?: string,
): Promise<string> {
  const useCloud = isPipelineArchitectCloud() || resolveCloudMode(session, "architect");
  const task = issueLabel
    ? `Fournis un cadrage architecture ciblé pour ${issueLabel} (contraintes, risques, points d'attention).`
    : "Fournis un cadrage architecture ciblé pour sécuriser l'exécution de ce backlog item (contraintes, risques, points d'attention).";
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

export async function runExecutionPipeline(
  session: OrchestratorSession,
  brief: string,
  opts: RunExecutionPipelineOptions = {},
): Promise<PipelineExecutionOutcome> {
  const defaultStart: PipelineStep = "dev";
  const resumeFrom = opts.resumeFrom ?? defaultStart;
  const startIdx = PIPELINE_STEPS.indexOf(resumeFrom);
  const runId = opts.pipelineRunId ?? newPipelineRunId();
  const startedAt = new Date().toISOString();
  const issueLabel = opts.executionIssueInfo
    ? `[${opts.executionIssueInfo.id}] "${opts.executionIssueInfo.title}"`
    : null;

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
  let lastQaVerdict = null as PipelineExecutionOutcome["lastQaVerdict"];
  let lastSecurityVerdict = null as PipelineExecutionOutcome["lastSecurityVerdict"];
  let detectedPrUrl: string | undefined;

  const briefForRecord =
    brief.length > 50_000 ? `${brief.slice(0, 50_000)}\n\n[… tronqué pour pipeline-runs.json …]` : brief;

  const pipelineIssueSize = opts.issueSize;

  try {
    console.log("═".repeat(60));
    console.log("🏗️  PIPELINE NEXT — Exécution Backlog -> QA");
    if (pipelineIssueSize) {
      console.log(`   📐 Taille issue (grille modèles) : ${pipelineIssueSize}`);
    }
    if (resumeFrom !== defaultStart) {
      const reason = opts.startReason ?? (opts.resumeFrom ? "--resume-from explicite" : "routing interne");
      console.log(`   ⏩ Démarrage depuis : ${resumeFrom.toUpperCase()} (${reason})`);
    }
    const plannedSteps = PIPELINE_STEPS.filter(
      (step) => step in EXECUTION_STEP_LABEL && PIPELINE_STEPS.indexOf(step) >= startIdx,
    )
      .map((step) => EXECUTION_STEP_LABEL[step as keyof typeof EXECUTION_STEP_LABEL])
      .join(" -> ");
    console.log(`   🗺️  Plan d'exécution : ${plannedSteps}`);
    console.log("═".repeat(60));

    let specs = brief;
    if (opts.executionIssueBacklogFields) {
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
    const reflectionChallenge = "";

    if (startIdx <= 1) {
      console.log("\n🏛️  ÉTAPE — Data Architect");
      architectureVision = await runArchitectForTicketExecution(
        session,
        specs,
        frugal,
        pipelineIssueSize,
        issueLabel ?? undefined,
      );
    } else {
      console.log("\n🏛️  ÉTAPE — Data Architect : ⏭  ignoré (--resume-from)");
    }

    const archExtract = extractHandoffSection(architectureVision, "## Handoff Dev — Architecture");
    warnIfHandoffFallback("Vision architecture (étape architecte)", architectureVision, "## Handoff Dev — Architecture", archExtract);
    const archHandoff = archExtract || (architectureVision ? trimContext(architectureVision, 1500) : "");

    const redteamExtract = extractHandoffSection(reflectionChallenge, "## Handoff Dev — Produit");
    warnIfHandoffFallback("Red team réflexion", reflectionChallenge, "## Handoff Dev — Produit", redteamExtract);
    const redteamHandoff = redteamExtract || (reflectionChallenge ? trimContext(reflectionChallenge, 1000) : "");

    const backlogArchCtx =
      !architectureVision && opts.executionIssueBacklogFields?.architectureVision
        ? `## Contexte architecture (backlog)\n${opts.executionIssueBacklogFields.architectureVision}`
        : "";
    const backlogRedteamCtx =
      !reflectionChallenge && opts.executionIssueBacklogFields?.reflectionChallenge
        ? `## Challenge backlog\n${opts.executionIssueBacklogFields.reflectionChallenge}`
        : "";

    const devContext = [
      `## Brief d'origine\n${brief}`,
      archHandoff || backlogArchCtx || null,
      redteamHandoff || backlogRedteamCtx || null,
    ]
      .filter(Boolean)
      .join("\n\n");

    if (startIdx <= 3) {
      console.log("\n💻 ÉTAPE — Développeur Full-Stack");
      if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");
    }

    let implementation =
      startIdx <= 3
        ? await runAgent(
            session,
            "dev",
            issueLabel
              ? `Implémente ${issueLabel} en respectant la vision architecture. Crée ou met à jour la PR.`
              : "Implémente les fonctionnalités du backlog Must/Should en respectant la vision architecture et ouvre/met à jour la PR.",
            { additionalContext: devContext, cloud: true, autoCreatePR: true, frugal, issueSize: pipelineIssueSize },
          )
        : brief;

    detectedPrUrl = detectGitHubPrUrl(implementation);
    if (detectedPrUrl) console.log(`   🔗 PR détectée : ${detectedPrUrl}`);

    let securityApproved = startIdx > 4;
    const maxSecurityIterations = 3;
    let securityReport = "";

    if (startIdx > 4) {
      console.log("\n🔐 ÉTAPE — Sécurité : ⏭  ignoré (--resume-from)");
    } else {
      while (!securityApproved && securityIteration < maxSecurityIterations) {
        securityIteration++;
        console.log(`\n🔐 ÉTAPE — Sécurité — itération ${securityIteration}/${maxSecurityIterations}`);
        if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");

        const securityPrompt =
          securityIteration === 1
            ? issueLabel
              ? `Audite la PR pour ${issueLabel}.`
              : "Audite la PR pour les vulnérabilités de sécurité."
            : `Re-audite après corrections.\n\nRapport précédent sécurité :\n${trimContext(securityReport, 2000)}`;

        assertDevOutputSufficientForSecurityAndQA(
          session,
          implementation,
          detectedPrUrl,
          `Garde-fou avant sécurité (itération ${securityIteration}/${maxSecurityIterations})`,
        );

        const implHandoffSecurity = extractHandoffSection(implementation, "## Handoff Security & QA");
        warnIfHandoffFallback(
          `Sortie développeur (→ sécurité, itération ${securityIteration})`,
          implementation,
          "## Handoff Security & QA",
          implHandoffSecurity,
        );

        securityReport = await runAgent(session, "security", securityPrompt, {
          additionalContext: buildSecurityImplementationContext(
            session,
            implHandoffSecurity || trimContext(implementation, 2000),
            detectedPrUrl,
            trimContext(brief, 800),
          ),
          cloud: true,
          frugal,
          issueSize: pipelineIssueSize,
          earlyStop: hasDefinitiveSecurityVerdict,
        });

        const securityVerdict = detectSecurityVerdict(securityReport);
        lastSecurityVerdict = securityVerdict;
        console.log(`   📋 Verdict sécurité (détecté) : ${securityVerdict}`);
        if (securityVerdict === "APPROVED") {
          securityApproved = true;
          console.log("✅ Sécurité approuvée — passage à QA.\n");
        } else if (securityVerdict === "CRITICAL_ISSUES" && securityIteration < maxSecurityIterations) {
          console.log("🔄 Vulnérabilités critiques — relance du développeur.\n");
          implementation = await runAgent(
            session,
            "dev",
            `Corrige les vulnérabilités critiques signalées par la sécurité.\n\n${trimContext(securityReport, 4000)}`,
            {
              additionalContext:
                devContext +
                (implementation ? `\n\n## Implémentation précédente\n${trimContext(implementation, 3000)}` : ""),
              cloud: true,
              autoCreatePR: false,
              frugal,
              issueSize: pipelineIssueSize,
            },
          );
          detectedPrUrl = detectGitHubPrUrl(implementation) ?? detectedPrUrl;
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

    const qaIssueBacklogSections: string[] = [];
    if (opts.executionIssueBacklogFields) {
      const f = opts.executionIssueBacklogFields;
      if (f.architectureVision?.trim()) {
        qaIssueBacklogSections.push(
          `## Vision architecture (issue backlog)\n\n${trimContext(f.architectureVision.trim(), 2000)}`,
        );
      }
      if (f.reflectionChallenge?.trim()) {
        qaIssueBacklogSections.push(
          `## Challenge produit / red team (issue backlog)\n\n${trimContext(f.reflectionChallenge.trim(), 2000)}`,
        );
      }
    }

    let qaApproved = false;
    const maxQAIterations = 3;
    let qaReport = "";

    while (!qaApproved && qaIteration < maxQAIterations) {
      qaIteration++;
      console.log(`\n🧪 ÉTAPE — QA Engineer — itération ${qaIteration}/${maxQAIterations}`);
      if (frugal) console.warn("   ⚠️  Mode frugal activé pour cette étape.");

      const qaPrompt =
        qaIteration === 1
          ? issueLabel
            ? `Review la PR pour ${issueLabel}. Vérifie le code, les tests et la conformité aux critères d'acceptation.`
            : "Review la PR créée par le développeur. Vérifie le code, les tests, et la conformité au backlog."
          : `Re-review la PR après les changements du développeur.\n\nVoici le rapport précédent de QA :\n${trimContext(qaReport, 3000)}\n\nVérifie si les problèmes identifiés ont été correctement adressés.`;

      assertDevOutputSufficientForSecurityAndQA(
        session,
        implementation,
        detectedPrUrl,
        `Garde-fou avant QA (itération ${qaIteration}/${maxQAIterations})`,
      );

      const implHandoffQa = extractHandoffSection(implementation, "## Handoff Security & QA");
      warnIfHandoffFallback(
        `Sortie développeur (→ QA, itération ${qaIteration})`,
        implementation,
        "## Handoff Security & QA",
        implHandoffQa,
      );

      qaReport = await runAgent(session, "qa", qaPrompt, {
        additionalContext: buildQAPipelineContext(
          session,
          [
            `## Issue implémentée\n${brief}`,
            ...qaIssueBacklogSections,
            archHandoff || null,
            securityReport ? `## Rapport sécurité\n${trimContext(securityReport, 1500)}` : null,
            `## Implémentation\n${implHandoffQa || trimContext(implementation, 2000)}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          detectedPrUrl,
        ),
        cloud: true,
        frugal,
        issueSize: pipelineIssueSize,
        earlyStop: hasDefinitiveQAVerdict,
      });

      const verdict = detectQAVerdict(qaReport);
      lastQaVerdict = verdict;
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
        `Corrige les problèmes soulevés par QA dans la revue précédente :\n\n${trimContext(qaReport, 4000)}\n\nMet à jour la PR avec les changements.`,
        {
          additionalContext:
            devContext + (implementation ? `\n\n## Implémentation précédente\n${trimContext(implementation, 3000)}` : ""),
          cloud: true,
          autoCreatePR: false,
          frugal,
          issueSize: pipelineIssueSize,
        },
      );
      detectedPrUrl = detectGitHubPrUrl(implementation) ?? detectedPrUrl;

      assertDevOutputSufficientForSecurityAndQA(
        session,
        implementation,
        detectedPrUrl,
        "Garde-fou avant sécurité (après correction demandée par QA)",
      );

      const implHandoffSecurityPostQa = extractHandoffSection(implementation, "## Handoff Security & QA");
      warnIfHandoffFallback(
        "Sortie développeur (→ sécurité après correction QA)",
        implementation,
        "## Handoff Security & QA",
        implHandoffSecurityPostQa,
      );

      const securityAfterQaFix = await runAgent(
        session,
        "security",
        "Re-vérifie rapidement les impacts sécurité après corrections demandées par QA.",
        {
          additionalContext: buildSecurityImplementationContext(
            session,
            implHandoffSecurityPostQa || trimContext(implementation, 2000),
            detectedPrUrl,
            trimContext(brief, 800),
          ),
          cloud: true,
          frugal,
          issueSize: pipelineIssueSize,
          earlyStop: hasDefinitiveSecurityVerdict,
        },
      );
      securityReport = securityAfterQaFix;
      const securityVerdict = detectSecurityVerdict(securityAfterQaFix);
      lastSecurityVerdict = securityVerdict;
      console.log(`   📋 Verdict sécurité (détecté) : ${securityVerdict}`);
      if (securityVerdict === "CRITICAL_ISSUES") {
        implementation = await runAgent(
          session,
          "dev",
          `Corrige les vulnérabilités critiques apparues après corrections QA :\n\n${trimContext(securityAfterQaFix, 3000)}`,
          {
            additionalContext:
              devContext + (implementation ? `\n\n## Implémentation précédente\n${trimContext(implementation, 3000)}` : ""),
            cloud: true,
            autoCreatePR: false,
            frugal,
            issueSize: pipelineIssueSize,
          },
        );
        detectedPrUrl = detectGitHubPrUrl(implementation) ?? detectedPrUrl;
      } else if (securityVerdict === "MEDIUM_ISSUES") {
        mediumSecurityNotes = true;
      }
    }

    const skipped = (step: PipelineStep) => PIPELINE_STEPS.indexOf(step) < startIdx;
    runStatus = resolveRunStatus(qaEscalated, securityEscalated, mediumSecurityNotes, lastSecurityVerdict);

    console.log("\n" + "═".repeat(60));
    console.log("📊 PIPELINE TERMINÉ — Résumé");
    console.log("═".repeat(60));
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
    if (!isGithubMergePrOnCiOkEnabled()) {
      console.log("\n👉 Va sur GitHub pour review final et merger la PR.");
    }
    return {
      runStatus,
      qaEscalated,
      securityEscalated,
      mediumSecurityNotes,
      lastQaVerdict,
      lastSecurityVerdict,
      detectedPrUrl,
    };
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
