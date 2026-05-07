import type { ProjectContext } from "../models.js";

/** État runtime du CLI (projet actif). Toujours passé en argument — pas de singleton mutable. */
export type OrchestratorSession = {
  activeProject: ProjectContext | null;
  activeProjectSlug: string | null;
};

export function emptyOrchestratorSession(): OrchestratorSession {
  return { activeProject: null, activeProjectSlug: null };
}
