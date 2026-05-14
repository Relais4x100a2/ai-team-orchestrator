import { formatProjectCoverageTargetLine } from "../models.js";
import { loadLastRunContext, resolveLastRunDir } from "./run-context.js";
import type { OrchestratorSession } from "./session.js";

/** Contexte injecté avant la sortie dev pour cadrer l'audit cloud sur la bonne branche / PR. */
export function buildSecurityImplementationContext(
  session: OrchestratorSession,
  implementationMarkdown: string,
  detectedPrUrl?: string,
  issueDescription?: string,
): string {
  const repo = session.activeProject?.repo?.trim() || process.env.TARGET_REPO_URL?.trim() || "—";
  const branch =
    session.backlogWorkBranch?.trim() ||
    session.activeProject?.branch?.trim() ||
    process.env.TARGET_BRANCH?.trim() ||
    "—";
  let branchUrlLine = "—";
  let prUrlLine = "—";
  if (session.activeProjectSlug) {
    const ctx = loadLastRunContext(resolveLastRunDir(session));
    if (ctx?.latestBranchUrl) branchUrlLine = ctx.latestBranchUrl;
    if (ctx?.latestPrUrl) prUrlLine = ctx.latestPrUrl;
  }
  // URL extraite directement de la sortie Dev — prioritaire sur run-context.json
  if (detectedPrUrl) prUrlLine = detectedPrUrl;

  return [
    "## Cible d'audit (pipeline)",
    "",
    `- **Dépôt** : ${repo}`,
    `- **Branche Git cloud (\`startingRef\`)** : ${branch}`,
    `- **Dernière URL branche** : ${branchUrlLine}`,
    `- **Dernière URL PR** : ${prUrlLine}`,
    "",
    "**Consigne** : audite le code et le diff de **cette branche / cette PR** dans l'environnement cloud Cursor. Si le workspace local ne reflète pas cette branche, indique-le dans le rapport mais base ton verdict sur **l'arbre distant** aligné avec la cible ci-dessus.",
    "",
    ...(issueDescription ? ["## Issue auditée", "", issueDescription, ""] : []),
    "## Sortie développeur / contexte implémentation",
    "",
    implementationMarkdown,
  ].join("\n");
}

/** Préfixe branche / PR pour l'agent QA (cohérent avec la cible cloud). */
export function buildQAPipelineContext(
  session: OrchestratorSession,
  innerMarkdown: string,
  detectedPrUrl?: string,
): string {
  const repo = session.activeProject?.repo?.trim() || process.env.TARGET_REPO_URL?.trim() || "—";
  const branch =
    session.backlogWorkBranch?.trim() ||
    session.activeProject?.branch?.trim() ||
    process.env.TARGET_BRANCH?.trim() ||
    "—";
  let branchUrlLine = "—";
  let prUrlLine = "—";
  if (session.activeProjectSlug) {
    const ctx = loadLastRunContext(resolveLastRunDir(session));
    if (ctx?.latestBranchUrl) branchUrlLine = ctx.latestBranchUrl;
    if (ctx?.latestPrUrl) prUrlLine = ctx.latestPrUrl;
  }
  // URL extraite directement de la sortie Dev — prioritaire sur run-context.json
  if (detectedPrUrl) prUrlLine = detectedPrUrl;

  return [
    "## Cible de review (pipeline)",
    "",
    `- **Dépôt** : ${repo}`,
    `- **Branche Git cloud (\`startingRef\`)** : ${branch}`,
    `- **Dernière URL branche** : ${branchUrlLine}`,
    `- **Dernière URL PR** : ${prUrlLine}`,
    formatProjectCoverageTargetLine(session.activeProject?.coverageLinesPct),
    "",
    "**Consigne** : revois le code et le diff de **cette branche / cette PR** dans l'environnement cloud Cursor. Si le workspace local diffère, signale-le mais base ton verdict sur l'arbre distant aligné avec la cible ci-dessus.",
    "",
    innerMarkdown,
  ].join("\n");
}
