import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { afterEach, describe, it } from "node:test";
import { join } from "path";
import type { Backlog, BacklogIssue } from "../backlog.js";
import { removeRunArtifactsForClosedIssue } from "./runs-cleanup.js";
import { LAST_RUN_CONTEXT_FILE } from "./run-context.js";
import { emptyOrchestratorSession } from "./session.js";
import type { OrchestratorSession } from "./session.js";

describe("removeRunArtifactsForClosedIssue", () => {
  const origCleanup = process.env.RUNS_CLEANUP_ON_ISSUE_DONE;

  afterEach(() => {
    if (origCleanup === undefined) delete process.env.RUNS_CLEANUP_ON_ISSUE_DONE;
    else process.env.RUNS_CLEANUP_ON_ISSUE_DONE = origCleanup;
  });

  function sessionWithDataDir(dir: string): OrchestratorSession {
    return {
      ...emptyOrchestratorSession(),
      activeProjectSlug: "slug",
      activeProject: {
        name: "P",
        repo: "https://github.com/a/b",
        branch: "main",
        content: "",
        localPath: dir,
        projectDataDir: dir,
      },
    };
  }

  const issue = (): BacklogIssue => ({
    id: "issue-001",
    title: "x",
    description: "d",
    status: "done",
    priority: "MUST",
    size: "S",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-02T00:00:00.000Z",
    pipelineRun: null,
  });

  it("sans env : ne supprime pas le répertoire", () => {
    delete process.env.RUNS_CLEANUP_ON_ISSUE_DONE;
    const root = mkdtempSync(join(tmpdir(), "orch-rcu-"));
    const docId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const runDir = join(root, "runs", docId, "issue-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "dev.md"), "x", "utf-8");
    const backlog: Backlog = {
      version: 2,
      lastUpdated: "2026-01-01T00:00:00.000Z",
      issues: [],
      backlogDocumentId: docId,
    };
    removeRunArtifactsForClosedIssue(sessionWithDataDir(root), backlog, issue(), "done");
    assert.ok(existsSync(runDir));
  });

  it("avec RUNS_CLEANUP_ON_ISSUE_DONE=1 : supprime runs/.../issue-001/", () => {
    process.env.RUNS_CLEANUP_ON_ISSUE_DONE = "1";
    const root = mkdtempSync(join(tmpdir(), "orch-rcu-"));
    const docId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const runDir = join(root, "runs", docId, "issue-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "dev.md"), "x", "utf-8");
    writeFileSync(
      join(root, LAST_RUN_CONTEXT_FILE),
      JSON.stringify({
        updatedAt: "2026-01-01T00:00:00.000Z",
        projectSlug: "slug",
        latestByRole: { dev: `runs/${docId}/issue-001/dev.md` },
      }),
      "utf-8",
    );
    const backlog: Backlog = {
      version: 2,
      lastUpdated: "2026-01-01T00:00:00.000Z",
      issues: [],
      backlogDocumentId: docId,
    };
    removeRunArtifactsForClosedIssue(sessionWithDataDir(root), backlog, issue(), "done");
    assert.ok(!existsSync(runDir));
    const ctx = JSON.parse(readFileSync(join(root, LAST_RUN_CONTEXT_FILE), "utf-8")) as { latestByRole: object };
    assert.deepEqual(ctx.latestByRole, {});
  });
});
