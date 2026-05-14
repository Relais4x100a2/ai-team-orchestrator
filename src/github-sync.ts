/**
 * Synchronisation backlog.json ↔ GitHub Issues.
 *
 * Pour chaque issue sans githubIssueNumber, crée une Issue GitHub
 * et met à jour backlog.json avec le numéro obtenu.
 *
 * Fermeture optionnelle après `pipeline next` : `closeGitHubIssueWithComment` (opt-in env).
 *
 * Prérequis : GITHUB_TOKEN dans .env, repo GitHub dans le fichier projet.
 */

import type { Backlog, BacklogIssue, IssuePriority, IssueSize } from "./models.js";
import { generateIssueId } from "./backlog.js";

/** Contexte machine pour le corps des issues GitHub (liaison document backlog). */
export type GitHubIssueBacklogContext = {
  backlogDocumentId: string;
  backlogRelativePath: string;
};

function isGithubSyncBacklogDocumentLabelEnabled(): boolean {
  const v = process.env.GITHUB_SYNC_BACKLOG_DOCUMENT_LABEL?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Extrait "owner/repo" depuis une URL GitHub. */
export function extractOwnerRepo(repoUrl: string): string {
  const match = repoUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw new Error(`URL GitHub non reconnue : ${repoUrl}`);
  return match[1];
}

/** En-têtes communs REST GitHub v2022-11-28 (création d’issue, commentaires, fermeture). */
export function githubApiHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function summarizeGithubErrorBody(raw: string, max = 280): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

export function buildGitHubIssueBody(issue: BacklogIssue, ctx: GitHubIssueBacklogContext): string {
  const lines: string[] = [
    `**Document backlog** : \`${ctx.backlogDocumentId}\``,
    `**Fichier backlog** : \`${ctx.backlogRelativePath}\``,
    "",
    `**Priorité :** ${issue.priority} | **Taille :** ${issue.size}`,
    "",
    issue.description || "_Voir le backlog PM pour les détails._",
    "",
    `---`,
    `*Généré par ai-team-orchestrator — id story : \`${issue.id}\`*`,
  ];
  return lines.join("\n");
}

function issueLabels(issue: BacklogIssue): string[] {
  const labels: string[] = [];
  if (issue.priority === "MUST") labels.push("priority:must");
  if (issue.priority === "SHOULD") labels.push("priority:should");
  if (issue.priority === "COULD") labels.push("priority:could");
  if (issue.size === "S") labels.push("size:S");
  if (issue.size === "M") labels.push("size:M");
  if (issue.size === "L") labels.push("size:L");
  if (issue.size === "XL") labels.push("size:XL");
  return labels;
}

async function createGitHubIssue(
  ownerRepo: string,
  token: string,
  issue: BacklogIssue,
  backlogCtx: GitHubIssueBacklogContext,
): Promise<number> {
  const labels = [...issueLabels(issue)];
  if (isGithubSyncBacklogDocumentLabelEnabled()) {
    labels.push(`backlog:${backlogCtx.backlogDocumentId}`);
  }
  const url = `https://api.github.com/repos/${ownerRepo}/issues`;
  const res = await fetch(url, {
    method: "POST",
    headers: githubApiHeaders(token),
    body: JSON.stringify({
      title: `[${issue.id}] ${issue.title}`,
      body: buildGitHubIssueBody(issue, backlogCtx),
      labels,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} pour "${issue.title}" : ${text}`);
  }

  const data = (await res.json()) as { number: number };
  return data.number;
}

const GITHUB_REST = "https://api.github.com/repos";

/**
 * POST commentaire sur une issue.
 * En cas d'échec HTTP : log d'avertissement uniquement (pas de throw).
 */
export async function postIssueComment(
  ownerRepo: string,
  token: string,
  issueNumber: number,
  body: string,
): Promise<boolean> {
  const url = `${GITHUB_REST}/${ownerRepo}/issues/${issueNumber}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: githubApiHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    console.warn(
      `GitHub: commentaire sur #${issueNumber} échoué (${res.status}) — ${summarizeGithubErrorBody(await res.text())}`,
    );
    return false;
  }
  return true;
}

/**
 * PATCH — ferme une issue (`state_reason` type GitHub).
 * @returns true si la fermeture a réussi
 */
export async function closeGitHubIssue(
  ownerRepo: string,
  token: string,
  issueNumber: number,
  stateReason: "completed" | "not_planned" = "completed",
): Promise<boolean> {
  const url = `${GITHUB_REST}/${ownerRepo}/issues/${issueNumber}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: githubApiHeaders(token),
    body: JSON.stringify({
      state: "closed",
      state_reason: stateReason,
    }),
  });
  if (!res.ok) {
    console.warn(
      `GitHub: fermeture issue #${issueNumber} échouée (${res.status}) — ${summarizeGithubErrorBody(await res.text())}`,
    );
    return false;
  }
  return true;
}

/**
 * Après pipeline réussi : GET (idempotence) → PATCH fermeture si encore ouverte → POST commentaire.
 * Fail-open : avertissements / logs, jamais de throw.
 */
export async function closeGitHubIssueWithComment(
  repoUrl: string,
  token: string,
  issueNumber: number,
  commentBody: string,
): Promise<void> {
  let ownerRepo: string;
  try {
    ownerRepo = extractOwnerRepo(repoUrl);
  } catch (e) {
    console.warn(`GitHub fermeture auto : ${(e as Error).message}`);
    return;
  }

  const issueUrl = `${GITHUB_REST}/${ownerRepo}/issues/${issueNumber}`;
  const headers = githubApiHeaders(token);

  const getRes = await fetch(issueUrl, { headers });
  if (getRes.status === 404) {
    console.warn(`GitHub: issue #${issueNumber} introuvable (404) — fermeture ignorée.`);
    return;
  }
  if (!getRes.ok) {
    console.warn(
      `GitHub: lecture issue #${issueNumber} impossible (${getRes.status}) — ${summarizeGithubErrorBody(await getRes.text())}`,
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = await getRes.json();
  } catch {
    console.warn(`GitHub: réponse JSON invalide pour issue #${issueNumber} — fermeture ignorée.`);
    return;
  }

  const state =
    typeof parsed === "object" && parsed !== null && "state" in parsed
      ? String((parsed as { state: unknown }).state)
      : "";
  if (state === "closed") {
    console.log(`GitHub: issue #${issueNumber} déjà fermée — rien à faire.`);
    return;
  }

  const ok = await closeGitHubIssue(ownerRepo, token, issueNumber, "completed");
  if (!ok) return;

  await postIssueComment(ownerRepo, token, issueNumber, commentBody);
}

/**
 * Crée les issues GitHub manquantes (sans githubIssueNumber) et met à jour le backlog.
 * Avant création, récupère les issues existantes sur GitHub et relie celles dont le titre
 * contient l'id interne (`[issue-xxx]`) pour éviter les doublons.
 * Retourne le nombre d'issues créées.
 */
export async function syncBacklogToGitHub(
  backlog: Backlog,
  repoUrl: string,
  token: string,
  options?: { backlogRelativePath?: string },
): Promise<number> {
  const docId = backlog.backlogDocumentId?.trim();
  if (!docId) {
    throw new Error(
      "syncBacklogToGitHub : backlog sans backlogDocumentId — ouvre le fichier avec loadBacklog pour migrer.",
    );
  }
  const backlogCtx: GitHubIssueBacklogContext = {
    backlogDocumentId: docId,
    backlogRelativePath: options?.backlogRelativePath?.trim() || "backlog.json",
  };
  const ownerRepo = extractOwnerRepo(repoUrl);

  // Récupère toutes les issues GitHub existantes pour déduplication par id interne.
  const existingGhIssues = await fetchAllGitHubIssues(ownerRepo, token);
  const ghByIssueId = new Map<string, number>();
  for (const gh of existingGhIssues) {
    const m = gh.title.match(/^\[([^\]]+)\]/);
    if (m) ghByIssueId.set(m[1], gh.number);
  }

  // Relie les issues backlog dont githubIssueNumber est absent mais qui existent déjà.
  const now = new Date().toISOString();
  let relinked = 0;
  for (const issue of backlog.issues) {
    if (!issue.githubIssueNumber && ghByIssueId.has(issue.id)) {
      issue.githubIssueNumber = ghByIssueId.get(issue.id)!;
      issue.updatedAt = now;
      console.log(`   🔗 #${issue.githubIssueNumber} — [${issue.id}] déjà sur GitHub (lien rétabli)`);
      relinked++;
    }
  }
  if (relinked > 0) console.log(`   ${relinked} issue(s) reliée(s) sans création.\n`);

  const pending = backlog.issues.filter(
    i => !i.githubIssueNumber && i.priority !== "WONT" && i.status !== "done" && i.status !== "skipped",
  );

  if (pending.length === 0) {
    console.log("✅ Toutes les issues ont déjà un numéro GitHub — rien à créer.");
    return 0;
  }

  console.log(`\n📋 Synchronisation vers github.com/${ownerRepo}`);
  console.log(`   ${pending.length} issue(s) à créer...\n`);

  let created = 0;
  for (const issue of pending) {
    try {
      const number = await createGitHubIssue(ownerRepo, token, issue, backlogCtx);
      issue.githubIssueNumber = number;
      issue.updatedAt = new Date().toISOString();
      console.log(`   ✅ #${number} — [${issue.id}] ${issue.title}`);
      created++;
      // Pause légère pour éviter le rate-limiting GitHub (secondaire)
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`   ❌ [${issue.id}] ${(e as Error).message}`);
    }
  }

  console.log(`\n   ${created}/${pending.length} issue(s) créée(s).`);
  return created;
}

// ─── Pull : GitHub Issues → backlog ──────────────────────────────────────────

/** Shape minimale d'une issue retournée par l'API GitHub. */
interface GitHubIssueRaw {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

/** Shape d'un commentaire retourné par l'API GitHub. */
export interface GitHubCommentRaw {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
}

/** Résumé de l'opération de pull GitHub → backlog. */
export interface PullSyncResult {
  statusClosed: number;
  labelsUpdated: number;
  conflicts: number;
  imported: number;
  noChange: number;
}

/**
 * Convertit les labels GitHub en champs priority/size de BacklogIssue.
 * Retourne null pour un champ absent (l'appelant ne surcharge pas la valeur existante).
 * Insensible à la casse pour la valeur après ":".
 */
export function parseLabelsFromGitHub(
  labels: Array<{ name: string }>,
): { priority: IssuePriority | null; size: IssueSize | null } {
  let priority: IssuePriority | null = null;
  let size: IssueSize | null = null;

  for (const label of labels) {
    if (!priority) {
      const pm = label.name.match(/^priority:(must|should|could|wont)$/i);
      if (pm) priority = pm[1]!.toUpperCase() as IssuePriority;
    }
    if (!size) {
      const sm = label.name.match(/^size:(S|M|L|XL)$/i);
      if (sm) size = sm[1]!.toUpperCase() as IssueSize;
    }
    if (priority && size) break;
  }

  return { priority, size };
}

/** Récupère toutes les issues d'un repo avec pagination automatique. PRs filtrées. */
async function fetchAllGitHubIssues(
  ownerRepo: string,
  token: string,
  perPage = 100,
): Promise<GitHubIssueRaw[]> {
  const collected: GitHubIssueRaw[] = [];
  let page = 1;

  while (true) {
    const url = `${GITHUB_REST}/${ownerRepo}/issues?state=all&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: githubApiHeaders(token) });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} lors de la pagination des issues (page ${page})`);
    }
    const batch = (await res.json()) as GitHubIssueRaw[];
    collected.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }

  return collected.filter(i => !("pull_request" in i));
}

/**
 * Récupère les commentaires d'une issue GitHub (limite 100, sans pagination).
 * Fail-open : retourne [] et log un warning en cas d'erreur HTTP.
 */
export async function fetchIssueComments(
  repoUrl: string,
  token: string,
  issueNumber: number,
): Promise<GitHubCommentRaw[]> {
  let ownerRepo: string;
  try {
    ownerRepo = extractOwnerRepo(repoUrl);
  } catch (e) {
    console.warn(`fetchIssueComments : ${(e as Error).message}`);
    return [];
  }

  const url = `${GITHUB_REST}/${ownerRepo}/issues/${issueNumber}/comments?per_page=100`;
  const res = await fetch(url, { headers: githubApiHeaders(token) });
  if (!res.ok) {
    console.warn(`⚠️  Commentaires GitHub #${issueNumber} : ${res.status} — ignorés.`);
    return [];
  }
  return (await res.json()) as GitHubCommentRaw[];
}

/**
 * Formate des commentaires GitHub en bloc Markdown pour injection dans le brief agent.
 * Retourne "" si comments est vide.
 */
export function formatIssueCommentsForBrief(
  issueNumber: number,
  comments: GitHubCommentRaw[],
): string {
  if (comments.length === 0) return "";

  const lines: string[] = [`## Commentaires GitHub (#${issueNumber})`, ""];
  for (const c of comments) {
    const login = c.user?.login ?? "inconnu";
    const date = c.created_at.slice(0, 10);
    lines.push(`### @${login} — ${date}`, "", c.body ?? "_(vide)_", "", "---", "");
  }
  return lines.join("\n");
}

/**
 * Synchronise GitHub Issues → backlog.json.
 * - Statuts : issue GitHub fermée + backlog todo → marquée done
 * - Labels : priority/size mis à jour depuis les labels GitHub
 * - Import : issues GitHub sans correspondance ajoutées (si importNew !== false)
 *
 * L'appelant est responsable de sauvegarder le backlog après.
 */
export async function pullIssuesFromGitHub(
  backlog: Backlog,
  repoUrl: string,
  token: string,
  options?: { importNew?: boolean },
): Promise<PullSyncResult> {
  const ownerRepo = extractOwnerRepo(repoUrl);
  const ghIssues = await fetchAllGitHubIssues(ownerRepo, token);

  const result: PullSyncResult = {
    statusClosed: 0,
    labelsUpdated: 0,
    conflicts: 0,
    imported: 0,
    noChange: 0,
  };

  const now = new Date().toISOString();
  const backlogByGhNumber = new Map<number, BacklogIssue>();
  for (const issue of backlog.issues) {
    if (issue.githubIssueNumber != null) backlogByGhNumber.set(issue.githubIssueNumber, issue);
  }

  for (const gh of ghIssues) {
    const local = backlogByGhNumber.get(gh.number);

    if (local) {
      let changed = false;
      let wasStatusClosed = false;

      if (gh.state === "closed" && local.status !== "done" && local.status !== "skipped") {
        if (local.status === "in_progress") {
          console.warn(
            `⚠️  Conflit : [${local.id}] est in_progress mais GitHub #${gh.number} est fermée. Pipeline en cours — ignoré.`,
          );
          result.conflicts++;
          continue;
        }
        local.status = "done";
        local.completedAt = now;
        local.updatedAt = now;
        console.log(`  ✅ [${local.id}] marquée done (GitHub #${gh.number} fermée)`);
        result.statusClosed++;
        wasStatusClosed = true;
        changed = true;
      }

      const labelChanges = parseLabelsFromGitHub(gh.labels);
      let labelsChanged = false;
      if (labelChanges.priority !== null && labelChanges.priority !== local.priority) {
        local.priority = labelChanges.priority;
        local.updatedAt = now;
        changed = true;
        labelsChanged = true;
      }
      if (labelChanges.size !== null && labelChanges.size !== local.size) {
        local.size = labelChanges.size;
        local.updatedAt = now;
        changed = true;
        labelsChanged = true;
      }
      if (labelsChanged && !wasStatusClosed) result.labelsUpdated++;

      if (!changed) result.noChange++;
    } else if (options?.importNew !== false) {
      const labelChanges = parseLabelsFromGitHub(gh.labels);
      const newId = generateIssueId(backlog);
      const newIssue: BacklogIssue = {
        id: newId,
        title: gh.title.slice(0, 200),
        description: `_Importée depuis GitHub #${gh.number}_\n\n(description à enrichir)`,
        status: gh.state === "closed" ? "done" : "todo",
        priority: labelChanges.priority ?? "SHOULD",
        size: labelChanges.size ?? "M",
        createdAt: now,
        updatedAt: now,
        completedAt: gh.state === "closed" ? now : null,
        pipelineRun: null,
        githubIssueNumber: gh.number,
        source: "bottom_up",
      };
      backlog.issues.push(newIssue);
      console.log(`  📥 [${newId}] importée depuis GitHub #${gh.number} : ${gh.title.slice(0, 60)}`);
      result.imported++;
    }
  }

  return result;
}
