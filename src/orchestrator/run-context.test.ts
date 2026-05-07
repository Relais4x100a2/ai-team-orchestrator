import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "path";
import {
  detectGitHubBranchUrl,
  detectGitHubPrUrl,
  resolveLastRunDir,
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
});
