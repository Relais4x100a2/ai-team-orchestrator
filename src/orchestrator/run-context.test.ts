import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { describe, it } from "node:test";
import { join, resolve } from "path";
import type { ProjectContext } from "../models.js";
import {
  detectGitHubBranchUrl,
  detectGitHubPrUrl,
  LAST_RUN_CONTEXT_FILE,
  resolveLastRunDir,
  saveLastRunContext,
} from "./run-context.js";
import { LAST_RUN_BASE_DIR } from "./paths-and-env.js";
import type { OrchestratorSession } from "./session.js";

describe("detectGitHubBranchUrl", () => {
  it("extrait une URL tree GitHub depuis du texte", () => {
    const text = "Branche créée : https://github.com/org/repo/tree/cursor/my-feature end";
    assert.equal(detectGitHubBranchUrl(text), "https://github.com/org/repo/tree/cursor/my-feature");
  });

  it("retourne undefined si aucune URL tree", () => {
    assert.equal(detectGitHubBranchUrl("pas d'URL ici"), undefined);
  });

  it("n'extrait pas une URL pull (PR)", () => {
    assert.equal(detectGitHubBranchUrl("https://github.com/org/repo/pull/42"), undefined);
  });
});

describe("detectGitHubPrUrl", () => {
  it("extrait une URL pull request", () => {
    const text = "PR ouverte : https://github.com/org/repo/pull/42 — review requis";
    assert.equal(detectGitHubPrUrl(text), "https://github.com/org/repo/pull/42");
  });

  it("extrait une URL new PR (branche)", () => {
    const text = "https://github.com/org/repo/pull/new/cursor/feature-branch";
    assert.equal(detectGitHubPrUrl(text), "https://github.com/org/repo/pull/new/cursor/feature-branch");
  });

  it("retourne undefined si aucune URL PR", () => {
    assert.equal(detectGitHubPrUrl("https://github.com/org/repo/tree/main"), undefined);
  });
});

describe("resolveLastRunDir", () => {
  it("retourne LAST_RUN_BASE_DIR/<slug> quand activeProjectSlug est défini", () => {
    const session: OrchestratorSession = { activeProject: null, activeProjectSlug: "mon-projet" };
    assert.equal(resolveLastRunDir(session), resolve(LAST_RUN_BASE_DIR, "mon-projet"));
  });

  it("retourne LAST_RUN_BASE_DIR quand activeProjectSlug est null", () => {
    const session: OrchestratorSession = { activeProject: null, activeProjectSlug: null };
    assert.equal(resolveLastRunDir(session), LAST_RUN_BASE_DIR);
  });

  it("retourne projectDataDir quand local_path et projectDataDir sont définis", () => {
    const dataDir = "/tmp/fake-repo/.ai-team-orchestrator";
    const project: ProjectContext = {
      name: "X",
      repo: "https://github.com/a/b",
      branch: "main",
      content: "",
      localPath: "/tmp/fake-repo",
      projectDataDir: dataDir,
    };
    const session: OrchestratorSession = {
      activeProject: project,
      activeProjectSlug: "slug",
    };
    assert.equal(resolveLastRunDir(session), dataDir);
  });
});

describe("saveLastRunContext", () => {
  it("refuse une écriture si le slug stocké diffère du projet actif", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-rc-"));
    writeFileSync(
      join(dir, LAST_RUN_CONTEXT_FILE),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        projectSlug: "autre-projet",
        latestByRole: {},
      }),
      "utf-8",
    );
    const session: OrchestratorSession = {
      activeProject: null,
      activeProjectSlug: "mon-projet",
    };
    assert.throws(
      () => saveLastRunContext(session, dir, "dev", "https://github.com/o/r/tree/feat\n"),
      /autre-projet/,
    );
  });
});
