import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { AgentRole } from "../agent-config.js";
import { formatDataDirPath, formatErrorMessage, LAST_RUN_BASE_DIR } from "./paths-and-env.js";
import type { OrchestratorSession } from "./session.js";

export const LAST_RUN_CONTEXT_FILE = "run-context.json";

export const ROLE_OUTPUT_FILE: Record<AgentRole, string> = {
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

export function saveLastRunContext(
  session: OrchestratorSession,
  lastRunDir: string,
  role: AgentRole,
  contextText: string,
): void {
  if (!session.activeProjectSlug) return;
  const previous = loadLastRunContext(lastRunDir);
  if (previous?.projectSlug && previous.projectSlug !== session.activeProjectSlug) {
    throw new Error(
      `Le répertoire ${formatDataDirPath(lastRunDir)} est déjà utilisé par le projet « ${previous.projectSlug} ». ` +
        "Choisis un autre `project_data_dir` pour ce projet.",
    );
  }
  const latestByRole = previous?.latestByRole ?? {};
  latestByRole[role] = ROLE_OUTPUT_FILE[role];

  const branchUrl = detectGitHubBranchUrl(contextText) ?? previous?.latestBranchUrl;
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
