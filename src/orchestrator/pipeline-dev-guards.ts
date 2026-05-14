import { isDevPipelineOutputTooWeak } from "./paths-and-env.js";
import { resolvePipelinePrUrl } from "./pipeline-pr-resolve.js";
import type { OrchestratorSession } from "./session.js";

/** Évite sécurité / QA sur une sortie dev vide ou sans PR ni handoff exploitable. */
export function assertDevOutputSufficientForSecurityAndQA(
  session: OrchestratorSession,
  implementation: string,
  detectedPrUrl: string | undefined,
  label: string,
): void {
  const pr = resolvePipelinePrUrl(session, {
    mode: "devGate",
    implementation,
    detectedPrUrl,
  });
  if (!isDevPipelineOutputTooWeak(implementation, { prUrl: pr })) return;
  const msg =
    "Sortie développeur insuffisante pour enchaîner sécurité / QA : texte quasi vide, pas de section «## Handoff Security & QA» exploitable, aucune URL de PR dans la sortie ni dans run-context.json. Vérifier l'agent dev ou relancer.";
  console.error(`❌ ${label}\n   ${msg}`);
  throw new Error(msg);
}
