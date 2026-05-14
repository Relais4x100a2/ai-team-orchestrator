import { writeFileSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline/promises";
import {
  buildGitHubTreeUrlForProject,
  extractBranchNameFromGitHubTreeUrl,
  isTrunkBranch,
} from "../project-branch-url.js";
import {
  LAST_RUN_CONTEXT_FILE,
  loadLastRunContext,
  resolveLastRunDir,
  type LastRunContext,
} from "./run-context.js";
import type { OrchestratorSession } from "./session.js";

function resolveBranchMismatchPolicy(): "prompt" | "warn" | "abort" {
  const raw = process.env.BRANCH_MISMATCH_POLICY?.trim().toLowerCase();
  if (raw === "warn" || raw === "abort" || raw === "prompt") return raw;
  return "prompt";
}

export function getProjectBranchMismatchContext(session: OrchestratorSession):
  | {
      activeBranch: string;
      expectedBranch: string;
      sourceUrl: string;
    }
  | null {
  if (!session.activeProjectSlug || !session.activeProject) return null;
  const lastRunDir = resolveLastRunDir(session);
  const context = loadLastRunContext(lastRunDir);
  if (!context?.latestBranchUrl) return null;

  const expectedBranch = extractBranchNameFromGitHubTreeUrl(context.latestBranchUrl);
  if (!expectedBranch) return null;
  /** Branches de travail orchestrées (`pipeline next`) : le frontmatter reste sur la branche d’intégration. */
  if (expectedBranch.startsWith("backlog/")) return null;
  const activeBranch = session.activeProject.branch?.trim();
  if (!activeBranch || activeBranch === expectedBranch) return null;

  return {
    activeBranch,
    expectedBranch,
    sourceUrl: context.latestBranchUrl,
  };
}

function resyncLastRunContextBranchToProjectTrunk(session: OrchestratorSession, lastRunDir: string): boolean {
  if (!session.activeProjectSlug || !session.activeProject) return false;
  const treeUrl = buildGitHubTreeUrlForProject(session.activeProject);
  if (!treeUrl) return false;
  const previous = loadLastRunContext(lastRunDir);
  const latestByRole = previous?.latestByRole ?? {};
  const nextContext: LastRunContext = {
    updatedAt: new Date().toISOString(),
    projectSlug: session.activeProjectSlug,
    latestByRole,
    latestBranchUrl: treeUrl,
  };
  writeFileSync(resolve(lastRunDir, LAST_RUN_CONTEXT_FILE), JSON.stringify(nextContext, null, 2), "utf-8");
  return true;
}

export async function enforceProjectBranchGuard(session: OrchestratorSession): Promise<void> {
  const mismatch = getProjectBranchMismatchContext(session);
  if (!mismatch) return;

  if (isTrunkBranch(mismatch.activeBranch)) {
    const resynced = resyncLastRunContextBranchToProjectTrunk(session, resolveLastRunDir(session));
    if (resynced) {
      console.log(
        `ℹ️  Branche projet « ${mismatch.activeBranch} » (intégration) : le last-run référençait encore « ${mismatch.expectedBranch} » ` +
          "(cas fréquent après merge de PR). run-context.json a été réaligné sur la branche du projet ; l’URL PR précédente a été retirée.",
      );
      return;
    }
  }

  const details =
    "\n⚠️  Branch mismatch détecté entre projet actif et dernier run context.\n" +
    `   - Branche projet active : ${mismatch.activeBranch}\n` +
    `   - Branche attendue (last-run): ${mismatch.expectedBranch}\n` +
    `   - Source: ${mismatch.sourceUrl}\n`;

  const policy = resolveBranchMismatchPolicy();
  if (policy === "abort") {
    console.error(
      `${details}` +
        "🛑 Exécution interrompue (BRANCH_MISMATCH_POLICY=abort).\n" +
        "   Aligne `branch:` dans projects/<projet>.md puis relance.",
    );
    process.exit(1);
  }
  if (policy === "warn") {
    console.warn(`${details}` + "   ℹ️  Continuer malgré l'écart (BRANCH_MISMATCH_POLICY=warn).");
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn(
      `${details}` +
        "   ⚠️  Terminal non interactif : poursuite par défaut.\n" +
        "   Astuce: BRANCH_MISMATCH_POLICY=abort pour bloquer automatiquement.",
    );
    return;
  }

  console.warn(details + "   Choix requis avant de continuer.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Continuer quand même ? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes" && answer !== "o" && answer !== "oui") {
    console.error("🛑 Exécution interrompue par l'utilisateur (mismatch de branche).");
    process.exit(1);
  }

  console.log("   ✅ Confirmation utilisateur : poursuite malgré mismatch de branche.");
}
