import type { ProjectContext } from "../models.js";

/** État runtime du CLI (projet actif). Toujours passé en argument — pas de singleton mutable. */
export type OrchestratorSession = {
  activeProject: ProjectContext | null;
  activeProjectSlug: string | null;
  /** Si défini, doit correspondre à `backlog.backlogDocumentId` après migration (`loadBacklog`). */
  cliBacklogDocumentId: string | null;
  /**
   * Sous-répertoire relatif au répertoire de données pour les sorties agents
   * (ex. `runs/<backlogDocumentId>/<issueId>` pendant `pipeline next`).
   */
  agentOutputRelativeSubdir: string | null;
  /** Branche Git locale + `startingRef` cloud pour l’exécution ticket (`backlog/...`). */
  backlogWorkBranch: string | null;
  /** Sprint actif — route les lectures/écritures du backlog vers `sprints/<id>/backlog.json`. */
  activeSprintId: string | null;
};

export function emptyOrchestratorSession(): OrchestratorSession {
  return {
    activeProject: null,
    activeProjectSlug: null,
    cliBacklogDocumentId: null,
    agentOutputRelativeSubdir: null,
    backlogWorkBranch: null,
    activeSprintId: null,
  };
}
