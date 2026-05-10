import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "path";
import type { ProjectContext } from "../models.js";
import { resolveBacklogPath } from "./backlog-io.js";
import { BACKLOG_FALLBACK_PATH, LAST_RUN_BASE_DIR } from "./paths-and-env.js";
import type { OrchestratorSession } from "./session.js";

describe("resolveBacklogPath", () => {
  it("renvoie last-run/<slug>/backlog.json quand activeProjectSlug est défini", () => {
    const session: OrchestratorSession = { activeProject: null, activeProjectSlug: "dataset-style" };
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
    const session: OrchestratorSession = { activeProject: project, activeProjectSlug: "slug" };
    assert.equal(resolveBacklogPath(session), resolve(dataDir, "backlog.json"));
  });

  it("renvoie BACKLOG_FALLBACK_PATH quand activeProjectSlug est null", () => {
    const session: OrchestratorSession = { activeProject: null, activeProjectSlug: null };
    assert.equal(resolveBacklogPath(session), BACKLOG_FALLBACK_PATH);
  });
});
