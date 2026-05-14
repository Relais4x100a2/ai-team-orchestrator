import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { describe, it } from "node:test";
import { join } from "path";
import { getProjectBranchMismatchContext } from "./branch-guard.js";
import { LAST_RUN_CONTEXT_FILE } from "./run-context.js";
import { emptyOrchestratorSession } from "./session.js";
import type { OrchestratorSession } from "./session.js";
import type { ProjectContext } from "../models.js";

const makeProject = (branch: string): ProjectContext => ({
  name: "Test",
  repo: "https://github.com/org/repo",
  branch,
  content: "",
});

describe("getProjectBranchMismatchContext", () => {
  it("retourne null si pas de projet actif dans la session", () => {
    const session: OrchestratorSession = { ...emptyOrchestratorSession(), activeProject: null, activeProjectSlug: null };
    assert.equal(getProjectBranchMismatchContext(session), null);
  });

  it("retourne null si activeProjectSlug est null (même avec projet)", () => {
    const session: OrchestratorSession = {
      ...emptyOrchestratorSession(),
      activeProject: makeProject("main"),
      activeProjectSlug: null,
    };
    assert.equal(getProjectBranchMismatchContext(session), null);
  });

  it("retourne null si run-context.json absent (slug fantôme)", () => {
    // Aucun fichier run-context.json n'existe pour ce slug fictif
    const session: OrchestratorSession = {
      ...emptyOrchestratorSession(),
      activeProject: makeProject("feature/new"),
      activeProjectSlug: "slug-fantome-xyz987",
    };
    assert.equal(getProjectBranchMismatchContext(session), null);
  });

  it("retourne null quand la branche attendue est une branche backlog/ (orchestrateur)", () => {
    const localRoot = mkdtempSync(join(tmpdir(), "orch-bgm-"));
    const dataDir = join(localRoot, ".data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, LAST_RUN_CONTEXT_FILE),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        projectSlug: "slug",
        latestByRole: {},
        latestBranchUrl: "https://github.com/org/repo/tree/backlog/01ARZ3NDEKTSV4RRFFQ69G5FAV-work",
      }),
      "utf-8",
    );
    const project: ProjectContext = {
      ...makeProject("main"),
      localPath: localRoot,
      projectDataDir: dataDir,
    };
    const session: OrchestratorSession = {
      ...emptyOrchestratorSession(),
      activeProject: project,
      activeProjectSlug: "slug",
    };
    assert.equal(getProjectBranchMismatchContext(session), null);
  });
});
