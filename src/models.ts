/**
 * Modèle de données (backlog, projet, pipeline) — source de vérité TypeScript
 * pour la persistance JSON locale.
 */

import { isAbsolute, normalize, resolve } from "path";

// --- Enums / alias --------------------------------------------------------

export type IssueStatus = "todo" | "in_progress" | "done" | "skipped";
export type IssuePriority = "MUST" | "SHOULD" | "COULD" | "WONT";
export type IssueSize = "S" | "M" | "L" | "XL";
export type IssueSource = "top_down" | "bottom_up";

export type PipelineStep =
  | "pm"
  | "architect"
  | "redteam_reflection"
  | "dev"
  | "security"
  | "qa";

export type PipelineRunStatus = "success" | "partial" | "failed";

/** Ordre des étapes du pipeline `full` (PM → … → red team). */
export const PIPELINE_STEPS: readonly PipelineStep[] = [
  "pm",
  "architect",
  "redteam_reflection",
  "dev",
  "security",
  "qa",
] as const;

// --- Entités --------------------------------------------------------------

export interface BacklogIssue {
  id: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  size: IssueSize;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  pipelineRun: string | null;
  githubIssueNumber?: number;
  source?: IssueSource;
  architectureVision?: string;
  architectureAlternative?: string;
  architectureRisks?: string;
  reflectionChallenge?: string;
}

export interface Backlog {
  version: number;
  lastUpdated: string;
  issues: BacklogIssue[];
  /**
   * Identifiant stable du fichier backlog (ULID). Absent dans les JSON legacy :
   * assigné automatiquement par `loadBacklog` (migration write-on-read).
   */
  backlogDocumentId?: string;
  /** Libellé optionnel pour le slug de branche Git `backlog/<id>-<slug>`. */
  themeLabel?: string;
}

/** Crockford base32 : 26 caractères (ULID). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isValidBacklogDocumentId(id: string): boolean {
  return typeof id === "string" && ULID_RE.test(id.trim());
}

export function parseCoverageLinesPct(value: unknown, fieldLabel: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldLabel} : nombre entre 0 et 100 attendu`);
  }
  if (value < 0 || value > 100) {
    throw new Error(`${fieldLabel} : doit être entre 0 et 100`);
  }
  return value;
}

export function formatProjectCoverageTargetLine(coverageLinesPct?: number): string {
  if (coverageLinesPct === undefined) return "";
  return `\n**Couverture lignes (cible) :** ${coverageLinesPct}%`;
}

export interface ProjectContext {
  name: string;
  repo: string;
  branch: string;
  content: string;
  /** Chemin absolu vers la copie locale du repo (optionnel). Utilisé comme workingDirectory pour les agents locaux. */
  localPath?: string;
  /** Répertoire de données (backlog, sorties agents, run-context) lorsque `local_path` est défini — absolu. */
  projectDataDir?: string;
  /** Fichier markdown de contexte long résolu (pour diagnostics). */
  projectContextPath?: string;
  /** Objectif de couverture lignes (0–100) pour les tests du dépôt cible. */
  coverageLinesPct?: number;
  /**
   * Branche de travail fixe pour le pipeline (ex. `ai-team/pipeline`).
   * Si absent, une branche `backlog/<id>-<slug>` est créée par issue.
   * Si présent et que la branche existe déjà localement, elle est simplement checkoutée.
   */
  workBranch?: string;
}

export interface PipelineRun {
  id: string;
  brief: string;
  resumeFrom: PipelineStep | null;
  qaIterations: number;
  securityIterations: number;
  status: PipelineRunStatus;
  startedAt: string;
  finishedAt: string | null;
}

export interface PipelineRunsFile {
  version: number;
  runs: PipelineRun[];
}

const ISSUE_STATUSES: IssueStatus[] = ["todo", "in_progress", "done", "skipped"];
const ISSUE_PRIORITIES: IssuePriority[] = ["MUST", "SHOULD", "COULD", "WONT"];
const ISSUE_SIZES: IssueSize[] = ["S", "M", "L", "XL"];
const ISSUE_SOURCES: IssueSource[] = ["top_down", "bottom_up"];
const PIPELINE_RUN_STATUSES: PipelineRunStatus[] = ["success", "partial", "failed"];

const ISO_MS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIso8601(s: string): boolean {
  if (!ISO_MS.test(s)) return false;
  const t = Date.parse(s);
  return !Number.isNaN(t);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function expectEnum<T extends string>(v: unknown, allowed: readonly T[], ctx: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new Error(`${ctx} : valeur invalide « ${String(v)} » (attendu : ${allowed.join(" | ")})`);
  }
  return v as T;
}

function validateBacklogIssue(raw: unknown, index: number): BacklogIssue {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`issues[${index}] : objet attendu`);
  }
  const o = raw as Record<string, unknown>;

  const id = o.id;
  if (!isNonEmptyString(id)) {
    throw new Error(`issues[${index}].id : chaîne non vide obligatoire`);
  }

  const title = o.title;
  if (!isNonEmptyString(title)) {
    throw new Error(`issues[${index}].title : chaîne non vide obligatoire`);
  }

  if (typeof o.description !== "string") {
    throw new Error(`issues[${index}].description : chaîne obligatoire`);
  }

  const status = expectEnum(o.status, ISSUE_STATUSES, `issues[${index}].status`);
  const priority = expectEnum(o.priority, ISSUE_PRIORITIES, `issues[${index}].priority`);
  const size = expectEnum(o.size, ISSUE_SIZES, `issues[${index}].size`);

  const createdAt = o.createdAt;
  const updatedAt = o.updatedAt;
  if (typeof createdAt !== "string" || !isIso8601(createdAt)) {
    throw new Error(`issues[${index}].createdAt : date ISO 8601 invalide`);
  }
  if (typeof updatedAt !== "string" || !isIso8601(updatedAt)) {
    throw new Error(`issues[${index}].updatedAt : date ISO 8601 invalide`);
  }

  let completedAt: string | null;
  if (o.completedAt === null) {
    completedAt = null;
  } else if (typeof o.completedAt === "string" && isIso8601(o.completedAt)) {
    completedAt = o.completedAt;
  } else {
    throw new Error(`issues[${index}].completedAt : null ou date ISO 8601 obligatoire`);
  }

  let pipelineRun: string | null;
  if (o.pipelineRun === null) {
    pipelineRun = null;
  } else if (isNonEmptyString(o.pipelineRun)) {
    pipelineRun = o.pipelineRun.trim();
  } else {
    throw new Error(`issues[${index}].pipelineRun : null ou chaîne non vide obligatoire`);
  }

  let source: IssueSource | undefined;
  if (o.source !== undefined) {
    source = expectEnum(o.source, ISSUE_SOURCES, `issues[${index}].source`);
  }

  const architectureVision =
    o.architectureVision === undefined
      ? undefined
      : typeof o.architectureVision === "string"
        ? o.architectureVision
        : (() => {
            throw new Error(`issues[${index}].architectureVision : chaîne attendue`);
          })();
  const architectureAlternative =
    o.architectureAlternative === undefined
      ? undefined
      : typeof o.architectureAlternative === "string"
        ? o.architectureAlternative
        : (() => {
            throw new Error(`issues[${index}].architectureAlternative : chaîne attendue`);
          })();
  const architectureRisks =
    o.architectureRisks === undefined
      ? undefined
      : typeof o.architectureRisks === "string"
        ? o.architectureRisks
        : (() => {
            throw new Error(`issues[${index}].architectureRisks : chaîne attendue`);
          })();
  const reflectionChallenge =
    o.reflectionChallenge === undefined
      ? undefined
      : typeof o.reflectionChallenge === "string"
        ? o.reflectionChallenge
        : (() => {
            throw new Error(`issues[${index}].reflectionChallenge : chaîne attendue`);
          })();

  let githubIssueNumber: number | undefined;
  if (o.githubIssueNumber !== undefined) {
    const n = o.githubIssueNumber;
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`issues[${index}].githubIssueNumber : entier positif obligatoire`);
    }
    githubIssueNumber = n;
  }

  return {
    id: id.trim(),
    title: title.trim(),
    description: o.description,
    status,
    priority,
    size,
    createdAt,
    updatedAt,
    completedAt,
    pipelineRun,
    ...(githubIssueNumber !== undefined ? { githubIssueNumber } : {}),
    source,
    architectureVision,
    architectureAlternative,
    architectureRisks,
    reflectionChallenge,
  };
}

/**
 * Valide la structure d'un backlog parsé depuis JSON.
 * Vérifie les enums, les dates ISO, l'unicité des ids et version >= 1.
 */
export function parseBacklogJson(raw: unknown, sourceLabel = "backlog.json"): Backlog {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`${sourceLabel} : racine objet attendue`);
  }
  const o = raw as Record<string, unknown>;

  const version = o.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`${sourceLabel}.version : entier >= 1 obligatoire`);
  }

  const lastUpdated = o.lastUpdated;
  if (typeof lastUpdated !== "string" || !isIso8601(lastUpdated)) {
    throw new Error(`${sourceLabel}.lastUpdated : date ISO 8601 obligatoire`);
  }

  if (!Array.isArray(o.issues)) {
    throw new Error(`${sourceLabel}.issues : tableau obligatoire`);
  }

  const issues: BacklogIssue[] = o.issues.map((item, i) => validateBacklogIssue(item, i));

  const ids = new Set<string>();
  for (const issue of issues) {
    if (ids.has(issue.id)) {
      throw new Error(`${sourceLabel} : id dupliqué « ${issue.id} »`);
    }
    ids.add(issue.id);
  }

  let backlogDocumentId: string | undefined;
  if (o.backlogDocumentId !== undefined) {
    if (typeof o.backlogDocumentId !== "string" || !isValidBacklogDocumentId(o.backlogDocumentId)) {
      throw new Error(`${sourceLabel}.backlogDocumentId : ULID (26 caractères) obligatoire si présent`);
    }
    backlogDocumentId = o.backlogDocumentId.trim();
  }

  let themeLabel: string | undefined;
  if (o.themeLabel !== undefined) {
    if (typeof o.themeLabel !== "string") {
      throw new Error(`${sourceLabel}.themeLabel : chaîne attendue`);
    }
    const t = o.themeLabel.trim();
    themeLabel = t.length ? t : undefined;
  }

  return { version, lastUpdated, issues, backlogDocumentId, themeLabel };
}

/** Résout un chemin de brief : absolu normalisé ou relatif au cwd. */
export function resolveBriefFilePath(userPath: string, cwd: string): string {
  const trimmed = userPath.trim();
  if (!trimmed) {
    throw new Error("Chemin de fichier brief vide.");
  }
  return isAbsolute(trimmed) ? normalize(trimmed) : resolve(cwd, trimmed);
}

export function assertValidProjectContext(project: ProjectContext, filePath: string): void {
  if (!isNonEmptyString(project.name)) {
    throw new Error(
      `Projet invalide (${filePath}) : le frontmatter « name » est obligatoire et ne peut pas être vide.`
    );
  }
}

export function isPipelineStep(s: string): s is PipelineStep {
  return (PIPELINE_STEPS as readonly string[]).includes(s);
}

export function validatePipelineRun(raw: unknown, index: number): PipelineRun {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`runs[${index}] : objet attendu`);
  }
  const o = raw as Record<string, unknown>;

  if (!isNonEmptyString(o.id)) {
    throw new Error(`runs[${index}].id : chaîne non vide obligatoire`);
  }
  if (typeof o.brief !== "string") {
    throw new Error(`runs[${index}].brief : chaîne obligatoire`);
  }

  let resumeFrom: PipelineStep | null;
  if (o.resumeFrom === null) {
    resumeFrom = null;
  } else if (typeof o.resumeFrom === "string" && isPipelineStep(o.resumeFrom)) {
    resumeFrom = o.resumeFrom;
  } else {
    throw new Error(`runs[${index}].resumeFrom : étape pipeline ou null obligatoire`);
  }

  const qaIterations = o.qaIterations;
  const securityIterations = o.securityIterations;
  if (typeof qaIterations !== "number" || !Number.isInteger(qaIterations) || qaIterations < 0) {
    throw new Error(`runs[${index}].qaIterations : entier >= 0 obligatoire`);
  }
  if (
    typeof securityIterations !== "number" ||
    !Number.isInteger(securityIterations) ||
    securityIterations < 0
  ) {
    throw new Error(`runs[${index}].securityIterations : entier >= 0 obligatoire`);
  }

  const status = expectEnum(o.status, PIPELINE_RUN_STATUSES, `runs[${index}].status`);

  const startedAt = o.startedAt;
  if (typeof startedAt !== "string" || !isIso8601(startedAt)) {
    throw new Error(`runs[${index}].startedAt : date ISO 8601 obligatoire`);
  }

  let finishedAt: string | null;
  if (o.finishedAt === null) {
    finishedAt = null;
  } else if (typeof o.finishedAt === "string" && isIso8601(o.finishedAt)) {
    finishedAt = o.finishedAt;
  } else {
    throw new Error(`runs[${index}].finishedAt : null ou date ISO 8601 obligatoire`);
  }

  return {
    id: o.id.trim(),
    brief: o.brief,
    resumeFrom,
    qaIterations,
    securityIterations,
    status,
    startedAt,
    finishedAt,
  };
}

export function parsePipelineRunsFile(raw: unknown, sourceLabel = "pipeline-runs.json"): PipelineRunsFile {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`${sourceLabel} : racine objet attendue`);
  }
  const o = raw as Record<string, unknown>;
  const version = o.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`${sourceLabel}.version : entier >= 1 obligatoire`);
  }
  if (!Array.isArray(o.runs)) {
    throw new Error(`${sourceLabel}.runs : tableau obligatoire`);
  }
  const runs = o.runs.map((r, i) => validatePipelineRun(r, i));
  return { version, runs };
}

export function newPipelineRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
