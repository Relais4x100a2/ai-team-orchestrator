/**
 * Types et logique pure du backlog (parse sortie PM, sélection prochaine issue).
 */

export type IssueStatus = "todo" | "in_progress" | "done" | "skipped";
export type IssuePriority = "MUST" | "SHOULD" | "COULD" | "WONT";
export type IssueSize = "S" | "M" | "L" | "XL";

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
}

export interface Backlog {
  version: number;
  lastUpdated: string;
  issues: BacklogIssue[];
}

export type ParsedIssueDraft = Omit<
  BacklogIssue,
  "id" | "createdAt" | "updatedAt" | "completedAt" | "pipelineRun"
>;

/** Extrait depuis la sortie texte du PM les user stories exploitables pour backlog.json. */
export function parsePMOutput(pmOutput: string): ParsedIssueDraft[] {
  const issues: ParsedIssueDraft[] = [];
  const blocks = pmOutput
    .split(/\n(?:---+|\*\*\*+)\n/)
    .filter(b => b.includes("🎯 User Story") || b.includes("User Story"));

  for (const block of blocks) {
    const h1Match = block.match(/^#\s+(.+?)$/m);
    let title = h1Match ? h1Match[1].trim() : null;

    if (!title) {
      const userStoryMatch = block.match(/je\s+veux\s+(.+?)\s+(?:afin|pour)\s+de/is);
      title = userStoryMatch ? userStoryMatch[1].trim().split("\n")[0] : null;
    }

    title = title || "Issue sans titre";

    const priorityMatch = block.match(
      /## [🏷️\s]*Priorit[ée][^\n]*\n+\[?(MUST|SHOULD|COULD|WONT)\]?/i
    );
    const priority = (priorityMatch?.[1]?.toUpperCase() ??
      "SHOULD") as IssuePriority;

    const sizeMatch = block.match(/## [📏\s]*Taille[^\n]*\n+\[?(S|M|L|XL)\]?/i);
    const size = (sizeMatch?.[1]?.toUpperCase() ?? "M") as IssueSize;

    issues.push({
      title,
      description: block.trim(),
      status: "todo",
      priority,
      size,
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
