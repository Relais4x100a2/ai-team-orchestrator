/**
 * Types et logique pure du backlog (parse sortie PM, sélection prochaine issue).
 */

export type {
  IssueStatus,
  IssuePriority,
  IssueSize,
  IssueSource,
  BacklogIssue,
  Backlog,
} from "./models.js";

import type { Backlog, BacklogIssue, IssuePriority, IssueSize } from "./models.js";

export type ParsedIssueDraft = Omit<
  BacklogIssue,
  "id" | "createdAt" | "updatedAt" | "completedAt" | "pipelineRun"
>;

/** Bloc plausible issue PM : titre User Story (# / ## / **), ou corps type story avec priorité+titre. */
function blockLooksLikePmIssue(block: string): boolean {
  const b = block.trim();
  if (!b) return false;
  if (/🎯\s*User\s+Story/i.test(b)) return true;
  if (/^#{1,3}[^\n]*User\s+Stor(?:y|ies)\b/im.test(b)) return true;
  if (/\*\*User\s+Story\*\*/i.test(b)) return true;
  const hasPersona =
    /\bEn\s+tant\s+que\b/i.test(b) || /\bas\s+a\b/i.test(b) || /\bje\s+veux\b/i.test(b);
  if (hasPersona && /\b(MUST|SHOULD|COULD|WONT)\b/i.test(b) && /\bTaille\b/i.test(b)) return true;
  return false;
}

function extractPriority(block: string): IssuePriority {
  const patterns = [
    /## [🏷️\s]*Priorit[ée][^\n]*\n+\[?\s*(MUST|SHOULD|COULD|WONT)\s*\]?/im,
    /##[^\n]*Priorit[ée][^\n]*\s*\n+\[?\s*(MUST|SHOULD|COULD|WONT)\s*\]?/im,
    /\*\*Priorit[ée]\*\*\s*\n+\[?\s*(MUST|SHOULD|COULD|WONT)\s*\]?/im,
  ];
  for (const p of patterns) {
    const m = block.match(p);
    if (m?.[1]) return m[1].toUpperCase() as IssuePriority;
  }
  return "SHOULD";
}

function extractSize(block: string): IssueSize {
  const patterns = [
    /## [📏\s]*Taille[^\n]*\n+\[?\s*(S|M|L|XL)\s*\]?/im,
    /##[^\n]*Taille[^\n]*\s*\n+\[?\s*(S|M|L|XL)\s*\]?/im,
    /\*\*Taille[^\n]*\*\*\s*\n+\[?\s*(S|M|L|XL)\s*\]?/im,
    /\*\*(?:Estimated\s+)?[Ss]ize\*\*\s*\n+\[?\s*(S|M|L|XL)\s*\]?/im,
  ];
  for (const p of patterns) {
    const m = block.match(p);
    if (m?.[1]) return m[1].toUpperCase() as IssueSize;
  }
  return "M";
}

/**
 * Extrait depuis la sortie texte du PM les user stories exploitables pour backlog.json.
 *
 * Contrainte : le découpage repose sur des lignes ne contenant que `---` ou `***` comme
 * séparateur entre les issues. Une ligne « --- » à **l'intérieur** d'une même story sera
 * interprétée comme fin de bloc et peut fragmenter le parse (le PM doit donc éviter ces
 * séparateurs horizontaux dans le corps d'une issue).
 */
export function parsePMOutput(pmOutput: string): ParsedIssueDraft[] {
  const issues: ParsedIssueDraft[] = [];
  const blocks = pmOutput
    .split(/\n(?:---+|\*\*\*+)\n/)
    .map(b => b.trim())
    .filter(Boolean)
    .filter(blockLooksLikePmIssue);

  for (const block of blocks) {
    const h1Match = block.match(/^#\s+(.+?)$/m);
    let title = h1Match ? h1Match[1].trim() : null;

    if (!title) {
      const userStoryMatch = block.match(/je\s+veux\s+(.+?)\s+(?:afin|pour)\s+de/is);
      title = userStoryMatch ? userStoryMatch[1].trim().split("\n")[0] : null;
    }

    if (!title) {
      const enTantMatch = block.match(/\bEn\s+tant\s+que\s+[^,\n]+,\s*je\s+veux\s+(.+?)(?:\.|$)/is);
      title = enTantMatch ? enTantMatch[1].trim().split("\n")[0] : null;
    }

    if (!title) {
      const asAMatch = block.match(/\bas\s+a\s+[^,\n]+,\s*i\s+(?:want|need)\s+(.+?)(?:\.|,|$)/is);
      title = asAMatch ? asAMatch[1].trim().split("\n")[0] : null;
    }

    title = title || "Issue sans titre";

    const priority = extractPriority(block);
    const size = extractSize(block);

    issues.push({
      title,
      description: block.trim(),
      status: "todo",
      priority,
      size,
      source: /\bbottom[-\s]?up\b|\bfeedback\b|\btesteur\b|\bincident\b/i.test(block)
        ? "bottom_up"
        : "top_down",
    });
  }

  return issues;
}

export function generateIssueId(backlog: Backlog): string {
  const maxNum = backlog.issues
    .map(i => parseInt(i.id.replace("issue-", ""), 10))
    .filter(n => !isNaN(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `issue-${String(maxNum + 1).padStart(3, "0")}`;
}

const PRIORITY_ORDER: Record<IssuePriority, number> = {
  MUST: 0,
  SHOULD: 1,
  COULD: 2,
  WONT: 3,
};
const SIZE_ORDER: Record<IssueSize, number> = { S: 0, M: 1, L: 2, XL: 3 };

/** Prochaine issue à traiter : todo, pas WONT, priorité puis taille croissantes. */
export function pickNextIssue(backlog: Backlog): BacklogIssue | null {
  const candidates = backlog.issues
    .filter(i => i.status === "todo" && i.priority !== "WONT")
    .sort((a, b) => {
      const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pd !== 0) return pd;
      return SIZE_ORDER[a.size] - SIZE_ORDER[b.size];
    });
  return candidates[0] ?? null;
}

/**
 * Chaîne utilisée pour le slug de branche Git (hors `themeLabel` explicite dans le backlog) :
 * même tri que `pickNextIssue` sur le premier candidat, sinon « backlog ».
 */
export function themeSourceForWorkBranch(backlog: Backlog): string {
  const next = pickNextIssue(backlog);
  if (next?.title?.trim()) return next.title.trim();
  return "backlog";
}
