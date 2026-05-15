import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";
import { ulid } from "ulid";
import { mkdirWithDefaultGitignoreIfNeeded } from "./paths-and-env.js";

export type SprintEntry = {
  id: string;
  createdAt: string;
  direction: "forward" | "backward";
  brief: string;
  issueCount: number;
};

export type SprintIndex = {
  activeSprint: string;
  sprints: SprintEntry[];
};

export function resolveSprintsDir(projectDataDir: string): string {
  return resolve(projectDataDir, "sprints");
}

export function resolveSprintIndexPath(projectDataDir: string): string {
  return resolve(resolveSprintsDir(projectDataDir), "index.json");
}

export function loadSprintIndex(projectDataDir: string): SprintIndex | null {
  const path = resolveSprintIndexPath(projectDataDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SprintIndex;
  } catch {
    return null;
  }
}

export function saveSprintIndex(projectDataDir: string, index: SprintIndex): void {
  const dir = resolveSprintsDir(projectDataDir);
  mkdirWithDefaultGitignoreIfNeeded(dir);
  writeFileSync(resolveSprintIndexPath(projectDataDir), JSON.stringify(index, null, 2), "utf-8");
}

export function createSprint(
  projectDataDir: string,
  direction: "forward" | "backward",
  brief: string,
): string {
  const id = ulid();
  mkdirSync(resolve(resolveSprintsDir(projectDataDir), id), { recursive: true });
  const existing = loadSprintIndex(projectDataDir);
  const truncatedBrief = brief.slice(0, 200);
  if (truncatedBrief.length < brief.length) {
    console.warn(`   ⚠️  Brief tronqué à 200 caractères (${brief.length} → 200).`);
  }
  const entry: SprintEntry = {
    id,
    createdAt: new Date().toISOString(),
    direction,
    brief: truncatedBrief,
    issueCount: 0,
  };
  saveSprintIndex(projectDataDir, {
    activeSprint: id,
    sprints: [...(existing?.sprints ?? []), entry],
  });
  return id;
}

export function updateSprintIssueCount(
  projectDataDir: string,
  sprintId: string,
  count: number,
): void {
  const index = loadSprintIndex(projectDataDir);
  if (!index) return;
  const entry = index.sprints.find((s) => s.id === sprintId);
  if (entry) entry.issueCount = count;
  saveSprintIndex(projectDataDir, index);
}

/**
 * Migre un `backlog.json` existant à la racine de `projectDataDir` vers `sprints/<ULID>/backlog.json`.
 * Sans effet si `sprints/` existe déjà ou si `backlog.json` est absent.
 */
export function migrateLegacyBacklogToSprint(projectDataDir: string): void {
  const legacyPath = resolve(projectDataDir, "backlog.json");
  if (!existsSync(legacyPath)) return;
  if (existsSync(resolveSprintsDir(projectDataDir))) return;
  const id = ulid();
  const sprintDir = resolve(resolveSprintsDir(projectDataDir), id);
  mkdirSync(sprintDir, { recursive: true });
  renameSync(legacyPath, resolve(sprintDir, "backlog.json"));
  saveSprintIndex(projectDataDir, {
    activeSprint: id,
    sprints: [
      {
        id,
        createdAt: new Date().toISOString(),
        direction: "forward",
        brief: "(migré depuis backlog.json)",
        issueCount: 0,
      },
    ],
  });
  console.log(`   🔄 Migration backlog : backlog.json → sprints/${id}/backlog.json`);
}
