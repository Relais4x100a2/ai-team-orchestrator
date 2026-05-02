/**
 * Configuration des agents : fichiers prompts et résolution MODEL_STRONG / MODEL_FAST.
 * Source unique utilisée par l’orchestrateur et par la vérif CI des fichiers Markdown.
 */

const DEFAULT_STRONG = "gpt-5-mini";
const DEFAULT_FAST = "composer-2";

const AGENT_DEFINITIONS = {
  pm: {
    promptFile: "product-manager",
    modelStrength: "strong" as const,
    description: "Product Manager — specs & backlog",
  },
  architect: {
    promptFile: "data-architect",
    modelStrength: "strong" as const,
    description: "Data Architect — modèle de données & architecture",
  },
  ux: {
    promptFile: "ux-designer",
    modelStrength: "fast" as const,
    description: "UX Designer — parcours utilisateur & wireframes",
  },
  dev: {
    promptFile: "fullstack-dev",
    modelStrength: "fast" as const,
    description: "Développeur Full-Stack — implémentation",
  },
  qa: {
    promptFile: "qa-engineer",
    modelStrength: "fast" as const,
    description: "QA Engineer — review & tests",
  },
  redteam: {
    promptFile: "red-team",
    modelStrength: "strong" as const,
    description: "Red Team — audit de sécurité",
  },
  devops: {
    promptFile: "devops-platform",
    modelStrength: "strong" as const,
    description: "DevOps / Plateforme — CI/CD & infra",
  },
  sre: {
    promptFile: "sre-observability",
    modelStrength: "strong" as const,
    description: "SRE / Observabilité — logs, métriques, alertes",
  },
  release: {
    promptFile: "release-manager",
    modelStrength: "fast" as const,
    description: "Release — versioning & changelog",
  },
  ui: {
    promptFile: "ui-designer",
    modelStrength: "fast" as const,
    description: "UI Designer — design visuel & tokens",
  },
  techwriter: {
    promptFile: "technical-writer",
    modelStrength: "fast" as const,
    description: "Rédaction technique — guides & doc utilisateur",
  },
  privacy: {
    promptFile: "privacy-by-design",
    modelStrength: "strong" as const,
    description: "Privacy by design — données & conformité produit",
  },
} as const;

export type AgentRole = keyof typeof AGENT_DEFINITIONS;

export type AgentRoleConfig = {
  promptFile: (typeof AGENT_DEFINITIONS)[AgentRole]["promptFile"];
  model: string;
  description: string;
};

export type AgentConfig = {
  readonly [K in AgentRole]: AgentRoleConfig;
};

/**
 * Liste des bases de fichier prompt (sans `.md`) référencées par AGENT_DEFINITIONS.
 */
export function expectedPromptBasenames(): string[] {
  const set = new Set<string>();
  for (const def of Object.values(AGENT_DEFINITIONS)) {
    set.add(def.promptFile);
  }
  return [...set].sort();
}

/** Construit la config résolue pour chaque rôle à partir des variables d’environnement. */
export function createAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const strong = env.MODEL_STRONG?.trim() || DEFAULT_STRONG;
  const fast = env.MODEL_FAST?.trim() || DEFAULT_FAST;

  const out = {} as Record<AgentRole, AgentRoleConfig>;
  for (const role of Object.keys(AGENT_DEFINITIONS) as AgentRole[]) {
    const def = AGENT_DEFINITIONS[role];
    out[role] = {
      promptFile: def.promptFile,
      model: def.modelStrength === "strong" ? strong : fast,
      description: def.description,
    };
  }
  return out as AgentConfig;
}

export const PIPELINE_STEPS = ["pm", "architect", "dev", "qa", "redteam"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
