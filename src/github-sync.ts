/**
 * Synchronisation backlog.json → GitHub Issues.
 *
 * Pour chaque issue sans githubIssueNumber, crée une Issue GitHub
 * et met à jour backlog.json avec le numéro obtenu.
 *
 * Prérequis : GITHUB_TOKEN dans .env, repo GitHub dans le fichier projet.
 */

import type { Backlog, BacklogIssue } from "./models.js";

/** Extrait "owner/repo" depuis une URL GitHub. */
export function extractOwnerRepo(repoUrl: string): string {
  const match = repoUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw new Error(`URL GitHub non reconnue : ${repoUrl}`);
  return match[1];
}

function issueBody(issue: BacklogIssue): string {
  const lines: string[] = [
    `**Priorité :** ${issue.priority} | **Taille :** ${issue.size}`,
    "",
    issue.description || "_Voir le backlog PM pour les détails._",
    "",
    `---`,
    `*Généré par ai-team-orchestrator — id interne : \`${issue.id}\`*`,
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
  return labels;
}

async function createGitHubIssue(
  ownerRepo: string,
  token: string,
  issue: BacklogIssue,
): Promise<number> {
  const url = `https://api.github.com/repos/${ownerRepo}/issues`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: `[${issue.id}] ${issue.title}`,
      body: issueBody(issue),
      labels: issueLabels(issue),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} pour "${issue.title}" : ${text}`);
  }

  const data = (await res.json()) as { number: number };
  return data.number;
}

/**
 * Crée les issues GitHub manquantes (sans githubIssueNumber) et met à jour le backlog.
 * Retourne le nombre d'issues créées.
 */
export async function syncBacklogToGitHub(
  backlog: Backlog,
  repoUrl: string,
  token: string,
): Promise<number> {
  const ownerRepo = extractOwnerRepo(repoUrl);
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
      const number = await createGitHubIssue(ownerRepo, token, issue);
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
