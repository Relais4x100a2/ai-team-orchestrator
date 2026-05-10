import { writeFileSync } from "fs";
import { resolve } from "path";
import { Agent } from "@cursor/sdk";
import {
  createAgentConfig,
  formatModelSelection,
  resolveRunModel,
  type AgentRole,
} from "../agent-config.js";
import type { IssueSize } from "../backlog.js";
import { runCloudAgentWithPolicy } from "../cloud-policy.js";
import { formatDataDirPath, formatErrorMessage, mkdirWithDefaultGitignoreIfNeeded, previewText } from "./paths-and-env.js";
import { loadPrompt } from "./prompts.js";
import {
  migrateLegacySecurityFile,
  resolveLastRunDir,
  ROLE_OUTPUT_FILE,
  saveLastRunContext,
} from "./run-context.js";
import { requireRepoUrlForCloud, resolveRepoUrl, syncLocalGitBeforeAgent } from "./git-sync.js";
import type { OrchestratorSession } from "./session.js";

export const AGENT_CONFIG = createAgentConfig();

/** Rôles pour lesquels une sortie vide est considérée comme une erreur après tentatives et secours cloud. */
const ROLES_REQUIRING_NON_EMPTY_OUTPUT = new Set<AgentRole>(["pm", "architect", "redteam_reflection"]);

/** Rôles qui nécessitent impérativement le cloud (accès PR GitHub, push de code). */
const ROLES_REQUIRING_CLOUD = new Set<AgentRole>(["dev", "security", "qa"]);

/**
 * Résout le mode d'exécution optimal pour un rôle donné.
 * - dev/security/qa → toujours cloud (interaction PR GitHub requise)
 * - autres rôles + localPath défini → local en premier (fallback cloud géré par runAgent)
 * - autres rôles sans localPath → cloud (pas de repo local disponible)
 */
export function resolveCloudMode(session: OrchestratorSession, role: AgentRole): boolean {
  if (ROLES_REQUIRING_CLOUD.has(role)) return true;
  return !session.activeProject?.localPath;
}

function normalizeAgentWaitOutcome(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "object" && raw !== null && "result" in raw) {
    const r = (raw as { result?: unknown }).result;
    return typeof r === "string" ? r.trim() : "";
  }
  return "";
}

export async function runAgent(
  session: OrchestratorSession,
  role: AgentRole,
  task: string,
  options: {
    cloud?: boolean;
    autoCreatePR?: boolean;
    additionalContext?: string;
    frugal?: boolean;
    issueSize?: IssueSize;
    /** Arrêt anticipé : appelé après chaque bloc de texte reçu ; si retourne true, le stream est annulé. */
    earlyStop?: (accumulated: string) => boolean;
  } = {},
): Promise<string> {
  const config = AGENT_CONFIG[role];
  syncLocalGitBeforeAgent(session, role);
  const model = resolveRunModel(role, {
    issueSize: options.issueSize,
    frugal: Boolean(options.frugal),
    env: process.env,
  });
  const prompt = loadPrompt(config.promptFile);

  console.log(`\n🚀 Lancement de l'agent : ${config.description}`);
  if (options.frugal) {
    console.log(`   Modèle : ${formatModelSelection(model)} ⚠️ mode frugal`);
  } else {
    console.log(`   Modèle : ${formatModelSelection(model)}`);
  }
  console.log(`   Mode : ${options.cloud ? "☁️  Cloud" : "💻 Local"}`);
  console.log(`   Tâche : ${previewText(task)}`);
  console.log("─".repeat(60));

  const fullTask = options.additionalContext
    ? `## Contexte des étapes précédentes\n\n${options.additionalContext}\n\n---\n\n## Ta tâche\n\n${task}`
    : task;

  const projectSection = session.activeProject
    ? `\n\n---\n\n## Contexte du projet cible\n\n**Projet :** ${session.activeProject.name}\n**Repo :** ${session.activeProject.repo}\n**Branche :** ${session.activeProject.branch}${session.activeProject.localPath ? `\n**Chemin local :** ${session.activeProject.localPath}` : ""}\n\n${session.activeProject.content}`
    : "";

  requireRepoUrlForCloud(session, options.cloud);

  const repoUrl = resolveRepoUrl(session);
  const branchRef = session.activeProject?.branch?.trim() || process.env.TARGET_BRANCH;

  if (!options.cloud && session.activeProject?.localPath) {
    console.log(`   Répertoire local : ${session.activeProject.localPath}`);
  }

  const roleAndTask = `${prompt}\n\n---\n\n${fullTask}`;
  const taskWithSystemPrompt = projectSection ? `${projectSection}\n\n---\n\n${roleAndTask}` : roleAndTask;

  const buildCreateOptionsForMode = (useCloud: boolean): Parameters<typeof Agent.create>[0] => {
    const base: Parameters<typeof Agent.create>[0] = {
      apiKey: process.env.CURSOR_API_KEY!,
      model,
    };
    if (useCloud) {
      Object.assign(base, {
        cloud: {
          repos: [
            {
              url: repoUrl!,
              ...(branchRef && { startingRef: branchRef }),
            },
          ],
          autoCreatePR: options.autoCreatePR ?? false,
        },
      });
    } else {
      const localCwd = session.activeProject?.localPath ?? process.cwd();
      Object.assign(base, { local: { cwd: localCwd } });
    }
    return base;
  };

  const executeRound = async (useCloud: boolean, label: string): Promise<string> => {
    if (useCloud) {
      requireRepoUrlForCloud(session, true);
    }
    const createOpts = buildCreateOptionsForMode(useCloud);
    console.log(`   🔄 ${label} (${useCloud ? "cloud" : "local"})`);

    const runOnce = async (): Promise<unknown> => {
      let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
      try {
        agent = await Agent.create(createOpts);
      } catch (e) {
        throw new Error(`Impossible de créer l'agent ${role} (${model.id}) : ${formatErrorMessage(e)}`, {
          cause: e,
        });
      }

      let run;
      try {
        run = await agent!.send(taskWithSystemPrompt);
      } catch (e) {
        throw new Error(`Échec de l'envoi de la tâche à l'agent ${role} : ${formatErrorMessage(e)}`, { cause: e });
      }

      try {
        // Stream for all modes: local never populates run.wait().result; cloud benefits from earlyStop
        let text = "";
        try {
          for await (const event of run!.stream()) {
            if (event.type === "assistant") {
              for (const block of event.message.content) {
                if (block.type === "text") {
                  text += block.text;
                  if (options.earlyStop?.(text)) {
                    run!.cancel().catch(() => {});
                    return text.trim();
                  }
                }
              }
            }
          }
        } catch (streamErr) {
          // Stream interrupted (e.g. after cancel): return partial text if non-empty
          if (!text) throw streamErr;
        }
        return text.trim();
      } catch (e) {
        throw new Error(`L'agent ${role} n'a pas terminé correctement : ${formatErrorMessage(e)}`, { cause: e });
      } finally {
        try {
          const disposable = agent as { [Symbol.asyncDispose]?: () => Promise<void> } | null;
          const asyncDispose = disposable?.[Symbol.asyncDispose];
          if (typeof asyncDispose === "function") {
            await asyncDispose.call(disposable);
          } else if (agent && "close" in agent && typeof agent.close === "function") {
            agent.close();
          }
        } catch (disposeErr) {
          console.warn(`⚠️  Nettoyage agent (${role}) incomplet : ${formatErrorMessage(disposeErr)}`);
        }
      }
    };

    const rawOutcome = useCloud
      ? await runCloudAgentWithPolicy(runOnce, process.env, `⚠️  cloud-policy (${role}) :`)
      : await runOnce();
    const text = normalizeAgentWaitOutcome(rawOutcome);
    console.log(`   📊 Sortie (${label}) : ${text.length} caractère(s)`);
    return text;
  };

  const primaryCloud = Boolean(options.cloud);
  const mustBeNonEmpty = ROLES_REQUIRING_NON_EMPTY_OUTPUT.has(role);
  let result = await executeRound(primaryCloud, "Tentative principale");

  if (mustBeNonEmpty && !result) {
    if (!primaryCloud) {
      console.warn("⚠️  Sortie vide — nouvelle exécution locale");
      result = await executeRound(false, "Nouvelle tentative (local)");
    }
  }

  if (mustBeNonEmpty && !result && !primaryCloud && resolveRepoUrl(session)) {
    console.warn("⚠️  Sortie vide encore — tentative de secours en cloud");
    result = await executeRound(true, "Secours cloud");
  }

  if (mustBeNonEmpty && !result && primaryCloud) {
    console.warn("⚠️  Sortie vide — nouvelle exécution cloud");
    result = await executeRound(true, "Nouvelle tentative (cloud)");
  }

  if (mustBeNonEmpty && !result) {
    throw new Error(
      `L'agent ${role} (${model.id}) s'est terminé sans texte exploitable après les tentatives automatiques.` +
        " Vérifie CURSOR_API_KEY, connexion Cursor, permissions du projet et journaux Agents.",
    );
  }

  if (result) {
    console.log(result);
  } else {
    console.log("(Pas de sortie retournée par l'agent)");
  }

  if (result) {
    if (!session.activeProjectSlug) {
      console.log(
        `\n   ℹ️  Sortie non sauvegardée (pas de --project). Passe --project projects/<fichier>.md pour activer la sauvegarde sous last-run/<slug>/ ou sous le dépôt local (local_path + données projet).`,
      );
    } else {
      try {
        const lastRunDir = resolveLastRunDir(session);
        mkdirWithDefaultGitignoreIfNeeded(lastRunDir);
        if (!session.activeProject?.projectDataDir) {
          migrateLegacySecurityFile(lastRunDir);
        }
        const outputFile = ROLE_OUTPUT_FILE[role];
        const outPath = resolve(lastRunDir, outputFile);
        writeFileSync(outPath, result, "utf-8");
        saveLastRunContext(session, lastRunDir, role, [task, options.additionalContext, result].filter(Boolean).join("\n\n"));
        console.log(`\n   💾 Sortie sauvegardée : ${formatDataDirPath(outPath)}`);
      } catch (e) {
        console.error(`   ⚠️  Impossible de sauvegarder la sortie agent : ${(e as Error).message}`);
      }
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`✅ Agent ${role} terminé.\n`);

  return result;
}
