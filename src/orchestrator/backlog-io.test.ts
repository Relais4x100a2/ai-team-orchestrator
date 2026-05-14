import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { describe, it } from "node:test";
import { join, resolve } from "path";
import { parseBacklogJson } from "../models.js";
import type { ProjectContext } from "../models.js";
import { loadBacklog, resolveBacklogPath } from "./backlog-io.js";
import { BACKLOG_FALLBACK_PATH, LAST_RUN_BASE_DIR } from "./paths-and-env.js";
import { emptyOrchestratorSession } from "./session.js";
import type { OrchestratorSession } from "./session.js";

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
