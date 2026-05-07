import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getProjectBranchMismatchContext } from "./branch-guard.js";
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
    const session: OrchestratorSession = { activeProject: null, activeProjectSlug: null };
    assert.equal(getProjectBranchMismatchContext(session), null);
  });

  it("retourne null si activeProjectSlug est null (même avec projet)", () => {
    const session: OrchestratorSession = { activeProject: makeProject("main"), activeProjectSlug: null };
    assert.equal(getProjectBranchMismatchContext(session), null);
  });

  it("retourne null si run-context.json absent (slug fantôme)", () => {
    // Aucun fichier run-context.json n'existe pour ce slug fictif
    const session: OrchestratorSession = {
      activeProject: makeProject("feature/new"),
      activeProjectSlug: "slug-fantome-xyz987",
    };
    assert.equal(getProjectBranchMismatchContext(session), null);
  });
});
