import { PIPELINE_STEPS, type PipelineStep } from "../agent-config.js";
import type { BacklogIssue, IssueSize } from "../backlog.js";
import { pickNextIssue } from "../backlog.js";
import { closeGitHubIssueWithComment, fetchIssueComments, formatIssueCommentsForBrief } from "../github-sync.js";
import {
  detectQAVerdict,
  detectSecurityVerdict,
  hasDefinitiveQAVerdict,
  hasDefinitiveSecurityVerdict,
} from "../pipeline-detection.js";
import { appendPipelineRun } from "../pipeline-runs.js";
import { checkFrugalMode } from "../spend-guard.js";
import type { PipelineRunStatus } from "../models.js";
import { newPipelineRunId } from "../models.js";
import { buildQAPipelineContext, buildSecurityImplementationContext } from "./context-builders.js";
import {
  extractHandoffSection,
  formatErrorMessage,
  isDevPipelineOutputTooWeak,
  trimContext,
  warnIfHandoffFallback,
} from "./paths-and-env.js";
import { detectGitHubPrUrl, loadLastRunContext, resolveLastRunDir } from "./run-context.js";
import { loadBacklog, saveBacklog, printBacklogSummary } from "./backlog-io.js";
import { runAgent, resolveCloudMode } from "./agent-runner.js";
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

function resolvePrUrlForDevOutputGate(
  session: OrchestratorSession,
  implementation: string,
  detectedPrUrl: string | undefined,
): string | undefined {
  const fromText = detectGitHubPrUrl(implementation);
  if (fromText) return fromText;
  const fromArg = detectedPrUrl?.trim();
  if (fromArg) return fromArg;
  if (session.activeProjectSlug) {
    const ctx = loadLastRunContext(resolveLastRunDir(session));
    const u = ctx?.latestPrUrl?.trim();
    if (u) return u;
  }
  return undefined;
}

/** Évite sécurité / QA sur une sortie dev vide ou sans PR ni handoff exploitable. */
function assertDevOutputSufficientForSecurityAndQA(
  session: OrchestratorSession,
  implementation: string,
  detectedPrUrl: string | undefined,
  label: string,
): void {
  const pr = resolvePrUrlForDevOutputGate(session, implementation, detectedPrUrl);
  if (!isDevPipelineOutputTooWeak(implementation, { prUrl: pr })) return;
  const msg =
    "Sortie développeur insuffisante pour enchaîner sécurité / QA : texte quasi vide, pas de section «## Handoff Security & QA» exploitable, aucune URL de PR dans la sortie ni dans run-context.json. Vérifier l'agent dev ou relancer.";
  console.error(`❌ ${label}\n   ${msg}`);
  throw new Error(msg);
}

async function runArchitectForTicketExecution(
  session: OrchestratorSession,
  specs: string,
  frugal: boolean,
  issueSize: IssueSize | undefined,
  issueLabel?: string,
): Promise<string> {
  // Si pas de localPath, forcer cloud même si PIPELINE_ARCHITECT_CLOUD=false
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

  // Enrichissement : commentaires GitHub comme contexte pour les agents
  let githubCommentsBlock = "";
  {
    const ghNum = issue.githubIssueNumber;
    const repo = session.activeProject?.repo?.trim();
    const ghToken = process.env.GITHUB_TOKEN?.trim();
    if (ghNum != null && repo && ghToken) {
      try {
        const comments = await fetchIssueComments(repo, ghToken, ghNum);
        if (comments.length > 0) {
          githubCommentsBlock = "\n\n" + formatIssueCommentsForBrief(ghNum, comments);
          console.log(`   💬 ${comments.length} commentaire(s) GitHub récupéré(s) pour #${ghNum}`);
        }
      } catch (e) {
        console.warn(`   ⚠️  Commentaires GitHub #${ghNum} : ${formatErrorMessage(e)}`);
      }
    }
  }

  try {
    const executionStartBySize: Record<IssueSize, PipelineStep> = {
      S: "dev",
      M: "architect",
      L: "architect",
      XL: "architect",
    };
    const executionStart = executionStartBySize[issue.size];
    await fullPipeline(session, issue.description + issueRef + githubCommentsBlock, {
      pipelineRunId,
      issueSize: issue.size,
      resumeFrom: executionStart,
      mode: "execution",
      startReason: `routing pipeline next (taille ${issue.size})`,
      executionIssueInfo: { id: issue.id, title: issue.title, priority: issue.priority, size: issue.size },
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
    executionIssueInfo?: { id: string; title: string; priority: string; size: string };
  } = {},
): Promise<void> {
  const isExecutionOnly = opts.mode === "execution";
  const defaultStart = isExecutionOnly ? "dev" : "pm";
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
        architectureVision = await runArchitectForTicketExecution(session, specs, frugal, pipelineIssueSize, issueLabel ?? undefined);
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

    const archExtract = extractHandoffSection(architectureVision, "## Handoff Dev — Architecture");
    warnIfHandoffFallback("Vision architecture (étape architecte)", architectureVision, "## Handoff Dev — Architecture", archExtract);
    const archHandoff =
      archExtract || (architectureVision ? trimContext(architectureVision, 1500) : "");

    const redteamExtract = extractHandoffSection(reflectionChallenge, "## Handoff Dev — Produit");
    warnIfHandoffFallback("Red team réflexion", reflectionChallenge, "## Handoff Dev — Produit", redteamExtract);
    const redteamHandoff =
      redteamExtract || (reflectionChallenge ? trimContext(reflectionChallenge, 1000) : "");

    // Pour size S (pas d'architecte dans ce run), récupérer les champs backlog
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
      console.log("\n💻 ÉTAPE 4/6 — Développeur Full-Stack");
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

    let detectedPrUrl: string | undefined = detectGitHubPrUrl(implementation);
    if (detectedPrUrl) console.log(`   🔗 PR détectée : ${detectedPrUrl}`);

    let securityApproved = startIdx > 4;
    const maxSecurityIterations = 3;
    let securityReport = "";

    if (startIdx > 4) {
      console.log("\n🔐 ÉTAPE 5/6 — Sécurité : ⏭  ignoré (--resume-from)");
    } else {
      while (!securityApproved && securityIteration < maxSecurityIterations) {
        securityIteration++;
        console.log(`\n🔐 ÉTAPE 5/6 — Sécurité — itération ${securityIteration}/${maxSecurityIterations}`);
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

        securityReport = await runAgent(
          session,
          "security",
          securityPrompt,
          {
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
            `Corrige les vulnérabilités critiques signalées par la sécurité.\n\n${trimContext(securityReport, 4000)}`,
            {
              additionalContext:
                devContext +
                (implementation
                  ? `\n\n## Implémentation précédente\n${trimContext(implementation, 3000)}`
                  : ""),
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
    if (isExecutionOnly && opts.executionIssueBacklogFields) {
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
      console.log(`\n🧪 ÉTAPE 6/6 — QA Engineer — itération ${qaIteration}/${maxQAIterations}`);
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

      qaReport = await runAgent(
        session,
        "qa",
        qaPrompt,
        {
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
        `Corrige les problèmes soulevés par QA dans la revue précédente :\n\n${trimContext(qaReport, 4000)}\n\nMet à jour la PR avec les changements.`,
        {
          additionalContext:
            devContext +
            (implementation
              ? `\n\n## Implémentation précédente\n${trimContext(implementation, 3000)}`
              : ""),
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
      console.log(`   📋 Verdict sécurité (détecté) : ${securityVerdict}`);
      if (securityVerdict === "CRITICAL_ISSUES") {
        implementation = await runAgent(
          session,
          "dev",
          `Corrige les vulnérabilités critiques apparues après corrections QA :\n\n${trimContext(securityAfterQaFix, 3000)}`,
          {
            additionalContext:
              devContext +
              (implementation
                ? `\n\n## Implémentation précédente\n${trimContext(implementation, 3000)}`
                : ""),
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
