import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { AgentRole } from "../agent-config.js";
import { buildGitHubTreeUrlForProject } from "../project-branch-url.js";
import { formatDataDirPath, formatErrorMessage, LAST_RUN_BASE_DIR } from "./paths-and-env.js";
import type { OrchestratorSession } from "./session.js";

export const LAST_RUN_CONTEXT_FILE = "run-context.json";

export const ROLE_OUTPUT_FILE: Record<AgentRole, string> = {
  po: "po.md",
  pm: "pm.md",
  architect: "architect.md",
  redteam_reflection: "redteam_reflection.md",
  dev: "dev.md",
  security: "security.md",
  qa: "qa.md",
  ux: "ux.md",
  ui: "ui.md",
  devops: "devops.md",
  sre: "sre.md",
  release: "release.md",
  techwriter: "techwriter.md",
  privacy: "privacy.md",
};

export type LastRunContext = {
  updatedAt: string;
  projectSlug: string;
  latestByRole: Partial<Record<AgentRole, string>>;
  latestBranchUrl?: string;
  latestPrUrl?: string;
};

export function resolveLastRunDir(session: OrchestratorSession): string {
  const proj = session.activeProject;
  if (proj?.localPath && proj.projectDataDir) {
    return proj.projectDataDir;
  }
  if (session.activeProjectSlug) return resolve(LAST_RUN_BASE_DIR, session.activeProjectSlug);
  return LAST_RUN_BASE_DIR;
}

export function detectGitHubBranchUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/tree\/[^\s)]+/i);
  return match?.[0];
}

export function detectGitHubPrUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(?:new\/[^\s)]+|\d+)/i);
  return match?.[0];
}

export function loadLastRunContext(lastRunDir: string): LastRunContext | null {
  const contextPath = resolve(lastRunDir, LAST_RUN_CONTEXT_FILE);
  if (!existsSync(contextPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(contextPath, "utf-8")) as LastRunContext;
    return raw;
  } catch {
    return null;
  }
}

export type SaveLastRunContextOptions = {
  /** Chemin relatif au `lastRunDir` (ex. `runs/<doc>/<issue>/dev.md`). */
  outputRelativePath?: string;
  /** Branche Git pour construire `latestBranchUrl` (prioritaire sur détection dans le texte). */
  branchOverride?: string;
};

export function saveLastRunContext(
  session: OrchestratorSession,
  lastRunDir: string,
  role: AgentRole,
  contextText: string,
  options?: SaveLastRunContextOptions,
): void {
  if (!session.activeProjectSlug) return;
  const previous = loadLastRunContext(lastRunDir);
  if (previous?.projectSlug && previous.projectSlug !== session.activeProjectSlug) {
    throw new Error(
      `Le répertoire ${formatDataDirPath(lastRunDir)} est déjà utilisé par le projet « ${previous.projectSlug} ». ` +
        "Choisis un autre `project_data_dir` pour ce projet.",
    );
  }
  const latestByRole = { ...(previous?.latestByRole ?? {}) };
  latestByRole[role] = options?.outputRelativePath ?? ROLE_OUTPUT_FILE[role];

  let branchUrl = previous?.latestBranchUrl;
  if (session.activeProject && options?.branchOverride?.trim()) {
    const built = buildGitHubTreeUrlForProject(session.activeProject, options.branchOverride.trim());
    if (built) branchUrl = built;
  }
  const fromText = detectGitHubBranchUrl(contextText);
  if (fromText) branchUrl = fromText;
  const prUrl = detectGitHubPrUrl(contextText) ?? previous?.latestPrUrl;

  const nextContext: LastRunContext = {
    updatedAt: new Date().toISOString(),
    projectSlug: session.activeProjectSlug,
    latestByRole,
    latestBranchUrl: branchUrl,
    latestPrUrl: prUrl,
  };
  writeFileSync(resolve(lastRunDir, LAST_RUN_CONTEXT_FILE), JSON.stringify(nextContext, null, 2), "utf-8");
}

/** Retire de `latestByRole` les chemins situés sous un préfixe (après suppression d’artefacts `runs/`). */
export function saveLastRunContextPruneRunsPrefix(
  session: OrchestratorSession,
  lastRunDir: string,
  pathPrefix: string,
): void {
  if (!session.activeProjectSlug) return;
  const previous = loadLastRunContext(lastRunDir);
  if (!previous?.latestByRole) return;
  const latestByRole = { ...previous.latestByRole };
  let changed = false;
  for (const key of Object.keys(latestByRole) as AgentRole[]) {
    const p = latestByRole[key];
    if (typeof p === "string" && (p === pathPrefix || p.startsWith(pathPrefix))) {
      delete latestByRole[key];
      changed = true;
    }
  }
  if (!changed) return;
  const nextContext: LastRunContext = {
    updatedAt: new Date().toISOString(),
    projectSlug: session.activeProjectSlug,
    latestByRole,
    latestBranchUrl: previous.latestBranchUrl,
    latestPrUrl: previous.latestPrUrl,
  };
  writeFileSync(resolve(lastRunDir, LAST_RUN_CONTEXT_FILE), JSON.stringify(nextContext, null, 2), "utf-8");
}

/** Retire `latestPrUrl` du run-context (nouveau sprint / défense en profondeur). */
export function clearLastRunPrUrl(session: OrchestratorSession): void {
  if (!session.activeProjectSlug) return;
  const lastRunDir = resolveLastRunDir(session);
  const previous = loadLastRunContext(lastRunDir);
  if (!previous?.latestPrUrl) return;
  const nextContext: LastRunContext = {
    updatedAt: new Date().toISOString(),
    projectSlug: session.activeProjectSlug,
    latestByRole: previous.latestByRole ?? {},
    latestBranchUrl: previous.latestBranchUrl,
  };
  writeFileSync(resolve(lastRunDir, LAST_RUN_CONTEXT_FILE), JSON.stringify(nextContext, null, 2), "utf-8");
}

export function migrateLegacySecurityFile(lastRunDir: string): void {
  const legacyPath = resolve(lastRunDir, "redteam.md");
  const securityPath = resolve(lastRunDir, "security.md");
  if (!existsSync(legacyPath) || existsSync(securityPath)) return;
  try {
    const legacy = readFileSync(legacyPath, "utf-8");
    writeFileSync(securityPath, legacy, "utf-8");
    console.log(
      `   ♻️  Migration ${formatDataDirPath(lastRunDir)} : redteam.md copié vers security.md`,
    );
  } catch (e) {
    console.warn(`   ⚠️  Migration redteam.md -> security.md impossible : ${formatErrorMessage(e)}`);
  }
}
