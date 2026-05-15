import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { describe, it } from "node:test";
import { join, resolve } from "path";
import { parseBacklogJson } from "../models.js";
import type { ProjectContext } from "../models.js";
import { formatBacklogForContext, loadBacklog, resolveBacklogPath } from "./backlog-io.js";
import { BACKLOG_FALLBACK_PATH, LAST_RUN_BASE_DIR } from "./paths-and-env.js";
import { emptyOrchestratorSession } from "./session.js";
import type { OrchestratorSession } from "./session.js";
import type { Backlog, BacklogIssue } from "../backlog.js";

describe("resolveBacklogPath", () => {
  it("renvoie last-run/<slug>/backlog.json quand activeProjectSlug est défini", () => {
    const session: OrchestratorSession = { ...emptyOrchestratorSession(), activeProject: null, activeProjectSlug: "dataset-style" };
    assert.equal(resolveBacklogPath(session), resolve(LAST_RUN_BASE_DIR, "dataset-style", "backlog.json"));
  });

  it("renvoie projectDataDir/backlog.json quand données embarquées dans le repo local", () => {
    const dataDir = "/tmp/foo/.ai-team-orchestrator";
    const project: ProjectContext = {
      name: "P",
      repo: "https://github.com/a/b",
      branch: "main",
      content: "",
      localPath: "/tmp/foo",
      projectDataDir: dataDir,
    };
    const session: OrchestratorSession = { ...emptyOrchestratorSession(), activeProject: project, activeProjectSlug: "slug" };
    assert.equal(resolveBacklogPath(session), resolve(dataDir, "backlog.json"));
  });

  it("renvoie BACKLOG_FALLBACK_PATH quand activeProjectSlug est null", () => {
    const session: OrchestratorSession = { ...emptyOrchestratorSession(), activeProject: null, activeProjectSlug: null };
    assert.equal(resolveBacklogPath(session), BACKLOG_FALLBACK_PATH);
  });

  it("renvoie sprints/<sprintId>/backlog.json quand activeSprintId est défini", () => {
    const dataDir = "/tmp/foo/.ai-team-orchestrator";
    const project: ProjectContext = {
      name: "P",
      repo: "https://github.com/a/b",
      branch: "main",
      content: "",
      localPath: "/tmp/foo",
      projectDataDir: dataDir,
    };
    const session: OrchestratorSession = {
      ...emptyOrchestratorSession(),
      activeProject: project,
      activeProjectSlug: "slug",
      activeSprintId: "01SPRINTTEST001ULID00000000",
    };
    assert.equal(
      resolveBacklogPath(session),
      resolve(dataDir, "sprints", "01SPRINTTEST001ULID00000000", "backlog.json"),
    );
  });
});

describe("loadBacklog migration backlogDocumentId", () => {
  it("réécrit le fichier sans id avec ULID et version 2", () => {
    const localRoot = mkdtempSync(join(tmpdir(), "orch-blio-"));
    const dataDir = join(localRoot, ".ai-team-orchestrator");
    mkdirSync(dataDir, { recursive: true });
    const legacy = { version: 1, lastUpdated: "2026-01-01T00:00:00.000Z", issues: [] };
    writeFileSync(join(dataDir, "backlog.json"), JSON.stringify(legacy), "utf-8");
    const project: ProjectContext = {
      name: "P",
      repo: "https://github.com/a/b",
      branch: "main",
      content: "",
      localPath: localRoot,
      projectDataDir: dataDir,
    };
    const session: OrchestratorSession = {
      ...emptyOrchestratorSession(),
      activeProject: project,
      activeProjectSlug: "slug",
    };
    const b = loadBacklog(session);
    assert.ok(b.backlogDocumentId && b.backlogDocumentId.length === 26);
    assert.equal(b.version, 2);
    const round = parseBacklogJson(JSON.parse(readFileSync(join(dataDir, "backlog.json"), "utf-8")));
    assert.equal(round.backlogDocumentId, b.backlogDocumentId);
    rmSync(localRoot, { recursive: true, force: true });
  });
});

describe("formatBacklogForContext", () => {
  const base: Omit<BacklogIssue, "id" | "status"> = {
    title: "Feature A",
    description: "Description de l'issue A.",
    priority: "MUST",
    size: "M",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    pipelineRun: null,
  };

  it("retourne une chaîne vide si aucune issue ouverte (done/skipped uniquement)", () => {
    const b: Backlog = {
      version: 2,
      lastUpdated: "",
      backlogDocumentId: "01TEST00000000000000000000",
      issues: [
        { ...base, id: "BP-001", status: "done" },
        { ...base, id: "BP-002", status: "skipped" },
      ],
    };
    assert.equal(formatBacklogForContext(b), "");
  });

  it("inclut les issues todo et in_progress, exclut done et skipped", () => {
    const b: Backlog = {
      version: 2,
      lastUpdated: "",
      backlogDocumentId: "01TEST00000000000000000000",
      issues: [
        { ...base, id: "BP-001", status: "todo" },
        { ...base, id: "BP-002", status: "in_progress" },
        { ...base, id: "BP-003", status: "done" },
        { ...base, id: "BP-004", status: "skipped" },
      ],
    };
    const result = formatBacklogForContext(b);
    assert.ok(result.includes("BP-001"));
    assert.ok(result.includes("BP-002"));
    assert.ok(!result.includes("BP-003"));
    assert.ok(!result.includes("BP-004"));
    assert.ok(result.includes("## Backlog existant (2 issue(s) ouvertes)"));
  });

  it("tronque à 3 000 caractères max avec marqueur [tronqué]", () => {
    const longDesc = "y".repeat(500);
    const issues: BacklogIssue[] = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      id: `BP-${String(i + 1).padStart(3, "0")}`,
      status: "todo" as const,
      description: longDesc,
    }));
    const b: Backlog = {
      version: 2,
      lastUpdated: "",
      backlogDocumentId: "01TEST00000000000000000000",
      issues,
    };
    const result = formatBacklogForContext(b);
    assert.ok(result.length <= 3100);
    assert.ok(result.includes("[…tronqué]"));
  });
});
