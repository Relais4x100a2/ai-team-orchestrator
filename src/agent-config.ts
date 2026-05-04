/**
 * Configuration des agents : modèles (ID + params SDK) et fichiers prompts.
 * Source unique utilisée par l'orchestrateur et par la vérif CI des fichiers Markdown.
 *
 * Hiérarchie de résolution du modèle (du plus prioritaire au moins) :
 *   1. MODEL_<ROLE> (ex: MODEL_PM=gpt-5.5) — override par rôle, sans params
 *   2. MODEL_STRONG / MODEL_FAST           — override par tier, sans params
 *   3. Grille taille d'issue (S/M/L/XL)     — rôles pipeline uniquement, si `issueSize` fourni (`resolveRunModel`)
 *   4. Défaut codé ci-dessous              — inclut les params SDK optimaux
 */

import type { IssueSize } from "./backlog.js";

/** Sélection de modèle transmise au SDK Cursor (shape identique à ModelSelection). */
export interface ModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

/** Modèle économique utilisé en mode frugal (seuil de dépenses atteint). */
export const FRUGAL_MODEL: ModelSelection = {
  id: "composer-2",
  params: [{ id: "fast", value: "true" }],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveModel(
  defaultModel: ModelSelection,
  perRoleEnv: string | undefined,
  tierEnv: string | undefined,
): ModelSelection {
  const override = perRoleEnv?.trim() || tierEnv?.trim();
  if (override) return { id: override }; // env override sans params (variant par défaut)
  return defaultModel;
}

// ---------------------------------------------------------------------------
// Définitions par rôle
//
// Stratégie coût/qualité :
//   - Pipeline (agents en boucle possible) : sonnet-4-6 ou composer-2 selon le besoin
//   - Agents hors-pipeline : composer-2 par défaut (invocations manuelles ponctuelles)
//   - Thinking activé là où le raisonnement profond est nécessaire (architect ;
//     redteam sur composer-2 avec thinking si le backend le prend en charge)
// ---------------------------------------------------------------------------

const AGENT_DEFINITIONS = {
  // ── Pipeline ─────────────────────────────────────────────────────────────
  pm: {
    promptFile: "product-manager",
    description: "Product Manager — specs & backlog",
    tier: "strong" as const,
    // Rédaction de specs : bon sens du contexte, pas besoin de thinking approfondi
    defaultModel: {
      id: "claude-sonnet-4-5",
      params: [
        { id: "thinking", value: "false" },
        { id: "context",  value: "200k" },
        { id: "effort",   value: "medium" },
      ],
    } satisfies ModelSelection,
  },
  architect: {
    promptFile: "data-architect",
    description: "Data Architect — modèle de données & architecture",
    tier: "strong" as const,
    // Décisions de design : thinking:true justifié (trade-off coût/qualité acceptable)
    defaultModel: {
      id: "claude-sonnet-4-5",
      params: [
        { id: "thinking", value: "true" },
        { id: "context",  value: "200k" },
        { id: "effort",   value: "medium" },
      ],
    } satisfies ModelSelection,
  },
  dev: {
    promptFile: "fullstack-dev",
    description: "Développeur Full-Stack — implémentation",
    tier: "fast" as const,
    // Composer 2 est le modèle natif Cursor, optimisé pour l'écriture de code
    defaultModel: {
      id: "composer-2",
      params: [{ id: "fast", value: "true" }],
    } satisfies ModelSelection,
  },
  qa: {
    promptFile: "qa-engineer",
    description: "QA Engineer — review & tests",
    tier: "fast" as const,
    // Tourne jusqu'à 3× en boucle — composer-2 est suffisant pour la review de code
    defaultModel: {
      id: "composer-2",
      params: [{ id: "fast", value: "true" }],
    } satisfies ModelSelection,
  },
  redteam: {
    promptFile: "red-team",
    description: "Red Team — audit de sécurité",
    tier: "strong" as const,
    // composer-2 sans fast ; thinking:true si exposé par le backend (sinon ignoré)
    defaultModel: {
      id: "composer-2",
      params: [{ id: "thinking", value: "true" }],
    } satisfies ModelSelection,
  },

  // ── Hors pipeline (invocations manuelles ponctuelles) ────────────────────
  ux: {
    promptFile: "ux-designer",
    description: "UX Designer — parcours utilisateur & wireframes",
    tier: "fast" as const,
    defaultModel: FRUGAL_MODEL,
  },
  ui: {
    promptFile: "ui-designer",
    description: "UI Designer — design visuel & tokens",
    tier: "fast" as const,
    defaultModel: FRUGAL_MODEL,
  },
  devops: {
    promptFile: "devops-platform",
    description: "DevOps / Plateforme — CI/CD & infra",
    tier: "fast" as const,
    defaultModel: FRUGAL_MODEL,
  },
  sre: {
    promptFile: "sre-observability",
    description: "SRE / Observabilité — logs, métriques, alertes",
    tier: "fast" as const,
    defaultModel: FRUGAL_MODEL,
  },
  release: {
    promptFile: "release-manager",
    description: "Release — versioning & changelog",
    tier: "fast" as const,
    defaultModel: FRUGAL_MODEL,
  },
  techwriter: {
    promptFile: "technical-writer",
    description: "Rédaction technique — guides & doc utilisateur",
    tier: "fast" as const,
    defaultModel: FRUGAL_MODEL,
  },
  privacy: {
    promptFile: "privacy-by-design",
    description: "Privacy by design — données & conformité produit",
    tier: "strong" as const,
    // Analyse de conformité : sonnet sans thinking est un bon compromis
    defaultModel: {
      id: "claude-sonnet-4-5",
      params: [
        { id: "thinking", value: "false" },
        { id: "context",  value: "200k" },
        { id: "effort",   value: "medium" },
      ],
    } satisfies ModelSelection,
  },
} as const;

export type AgentRole = keyof typeof AGENT_DEFINITIONS;

/** Clés d'environnement `MODEL_*` par rôle. */
const PER_ROLE_ENV_KEY: Record<AgentRole, string> = {
  pm: "MODEL_PM",
  architect: "MODEL_ARCHITECT",
  ux: "MODEL_UX",
  dev: "MODEL_DEV",
  qa: "MODEL_QA",
  redteam: "MODEL_REDTEAM",
  devops: "MODEL_DEVOPS",
  sre: "MODEL_SRE",
  release: "MODEL_RELEASE",
  ui: "MODEL_UI",
  techwriter: "MODEL_TECHWRITER",
  privacy: "MODEL_PRIVACY",
};

/** Rôles du pipeline `full` pour lesquels la grille S/M/L/XL s'applique. */
const PIPELINE_ROLE_WITH_SIZE_GRID = new Set<AgentRole>(["pm", "architect", "dev", "qa", "redteam"]);

const COMPOSER_FAST: ModelSelection = {
  id: "composer-2",
  params: [{ id: "fast", value: "true" }],
};

const COMPOSER_SLOW: ModelSelection = {
  id: "composer-2",
  params: [{ id: "fast", value: "false" }],
};

const COMPOSER_THINK: ModelSelection = {
  id: "composer-2",
  params: [{ id: "thinking", value: "true" }],
};

const HAIKU_PM: ModelSelection = {
  id: "claude-haiku-4-5",
  params: [{ id: "context", value: "200k" }],
};

const PM_XL: ModelSelection = {
  id: "claude-sonnet-4-5",
  params: [
    { id: "thinking", value: "false" },
    { id: "context", value: "200k" },
    { id: "effort", value: "high" },
  ],
};

const ARCHITECT_OPUS: ModelSelection = {
  id: "claude-opus-4-7",
  params: [
    { id: "thinking", value: "true" },
    { id: "context", value: "200k" },
    { id: "effort", value: "medium" },
  ],
};

const REDTEAM_SONNET: ModelSelection = {
  id: "claude-sonnet-4-5",
  params: [
    { id: "thinking", value: "true" },
    { id: "context", value: "200k" },
    { id: "effort", value: "medium" },
  ],
};

/**
 * Modèle de base pour un rôle pipeline avant overrides env, selon la taille d'issue.
 * L = défauts `AGENT_DEFINITIONS` ; S/M/XL = variantes coût / qualité.
 */
function modelForRoleAndIssueSize(role: AgentRole, size: IssueSize): ModelSelection {
  if (size === "L") {
    return AGENT_DEFINITIONS[role].defaultModel as ModelSelection;
  }
  switch (role) {
    case "pm":
      return size === "XL" ? PM_XL : HAIKU_PM;
    case "architect":
      if (size === "S") return COMPOSER_FAST;
      if (size === "XL") return ARCHITECT_OPUS;
      return AGENT_DEFINITIONS.architect.defaultModel as ModelSelection;
    case "dev":
      return size === "XL" ? COMPOSER_SLOW : COMPOSER_FAST;
    case "qa":
      return size === "XL" ? COMPOSER_SLOW : COMPOSER_FAST;
    case "redteam":
      return size === "XL" ? REDTEAM_SONNET : COMPOSER_THINK;
    default:
      return AGENT_DEFINITIONS[role].defaultModel as ModelSelection;
  }
}

/**
 * Résout le modèle pour un run (pipeline avec `issueSize`, mode frugal, overrides `.env`).
 */
export function resolveRunModel(
  role: AgentRole,
  opts: { issueSize?: IssueSize; frugal: boolean; env?: NodeJS.ProcessEnv },
): ModelSelection {
  const env = opts.env ?? process.env;
  if (opts.frugal) return FRUGAL_MODEL;

  const def = AGENT_DEFINITIONS[role];
  const useGrid =
    opts.issueSize !== undefined && PIPELINE_ROLE_WITH_SIZE_GRID.has(role);
  const base = useGrid
    ? modelForRoleAndIssueSize(role, opts.issueSize!)
    : (def.defaultModel as ModelSelection);

  const rawPerRole = env[PER_ROLE_ENV_KEY[role] as keyof NodeJS.ProcessEnv];
  const perRoleTrimmed =
    typeof rawPerRole === "string" ? rawPerRole.trim() || undefined : undefined;
  const tierEnv =
    def.tier === "strong"
      ? env.MODEL_STRONG?.trim() || undefined
      : env.MODEL_FAST?.trim() || undefined;

  return resolveModel(base, perRoleTrimmed, tierEnv);
}

export type AgentRoleConfig = {
  promptFile: string;
  model: ModelSelection;
  description: string;
};

export type AgentConfig = { readonly [K in AgentRole]: AgentRoleConfig };

/** Liste des bases de fichier prompt (sans `.md`) référencées par AGENT_DEFINITIONS. */
export function expectedPromptBasenames(): string[] {
  const set = new Set<string>();
  for (const def of Object.values(AGENT_DEFINITIONS)) {
    set.add(def.promptFile);
  }
  return [...set].sort();
}

/** Construit la config résolue pour chaque rôle (sans `issueSize` — équivalent invocations hors `fullPipeline` avec taille). */
export function createAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const out = {} as Record<AgentRole, AgentRoleConfig>;
  for (const role of Object.keys(AGENT_DEFINITIONS) as AgentRole[]) {
    const def = AGENT_DEFINITIONS[role];
    out[role] = {
      promptFile: def.promptFile,
      description: def.description,
      model: resolveRunModel(role, { frugal: false, env }),
    };
  }
  return out as AgentConfig;
}

/** Formate un ModelSelection pour l'affichage dans les logs. */
export function formatModelSelection(m: ModelSelection): string {
  if (!m.params?.length) return m.id;
  const p = m.params.map(({ id, value }) => `${id}:${value}`).join(", ");
  return `${m.id} (${p})`;
}

export const PIPELINE_STEPS = ["pm", "architect", "dev", "qa", "redteam"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
