import { mkdirSync, writeFileSync } from "fs";
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
import { formatErrorMessage, previewText } from "./paths-and-env.js";
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

  const agentOptions: Parameters<typeof Agent.create>[0] = {
    apiKey: process.env.CURSOR_API_KEY!,
    model,
  };

  const repoUrl = resolveRepoUrl(session);
  const branchRef = session.activeProject?.branch?.trim() || process.env.TARGET_BRANCH;

  if (options.cloud) {
    Object.assign(agentOptions, {
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
    Object.assign(agentOptions, {
      local: { cwd: localCwd },
    });
    if (session.activeProject?.localPath) {
      console.log(`   Répertoire local : ${session.activeProject.localPath}`);
    }
  }

  const roleAndTask = `${prompt}\n\n---\n\n${fullTask}`;
  const taskWithSystemPrompt = projectSection ? `${projectSection}\n\n---\n\n${roleAndTask}` : roleAndTask;

  const runOnce = async () => {
    let agent: Awaited<ReturnType<typeof Agent.create>> | null = null;
    try {
      agent = await Agent.create(agentOptions);
    } catch (e) {
      throw new Error(`Impossible de créer l'agent ${role} (${model.id}) : ${formatErrorMessage(e)}`, { cause: e });
    }

    let run;
    try {
      run = await agent.send(taskWithSystemPrompt);
    } catch (e) {
      throw new Error(`Échec de l'envoi de la tâche à l'agent ${role} : ${formatErrorMessage(e)}`, { cause: e });
    }

    try {
      return await run.wait();
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

  const runResult = options.cloud
    ? await runCloudAgentWithPolicy(runOnce, process.env, `⚠️  cloud-policy (${role}) :`)
    : await runOnce();

  if (runResult.result) {
    console.log(runResult.result);
  } else {
    console.log("(Pas de sortie retournée par l'agent)");
  }
  const result = runResult.result || "";

  if (result) {
    if (!session.activeProjectSlug) {
      console.log(
        `\n   ℹ️  Sortie non sauvegardée (pas de --project). Passe --project projects/<fichier>.md pour activer last-run/<slug>/${role}.md.`,
      );
    } else {
      try {
        const lastRunDir = resolveLastRunDir(session);
        mkdirSync(lastRunDir, { recursive: true });
        migrateLegacySecurityFile(lastRunDir);
        const outputFile = ROLE_OUTPUT_FILE[role];
        writeFileSync(resolve(lastRunDir, outputFile), result, "utf-8");
        saveLastRunContext(session, lastRunDir, role, [task, options.additionalContext, result].filter(Boolean).join("\n\n"));
        console.log(`\n   💾 Sortie sauvegardée : last-run/${session.activeProjectSlug}/${outputFile}`);
      } catch (e) {
        console.error(`   ⚠️  Impossible de sauvegarder la sortie last-run : ${(e as Error).message}`);
      }
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`✅ Agent ${role} terminé.\n`);

  return result;
}
