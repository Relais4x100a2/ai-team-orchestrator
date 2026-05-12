import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  buildGitHubTreeUrlForProject,
  extractBranchNameFromGitHubTreeUrl,
  isTrunkBranch,
  resolveTrunkBranchNames,
} from "./project-branch-url.js";
import type { ProjectContext } from "./models.js";

describe("project-branch-url", () => {
  describe("extractBranchNameFromGitHubTreeUrl", () => {
    it("extrait la branche depuis une URL tree", () => {
      assert.equal(
        extractBranchNameFromGitHubTreeUrl(
          "https://github.com/org/repo/tree/cursor/xml-importer-roundtrip-f0fc",
        ),
        "cursor/xml-importer-roundtrip-f0fc",
      );
    });
  });

  describe("buildGitHubTreeUrlForProject", () => {
    it("construit l’URL depuis https et branche", () => {
      const p: ProjectContext = {
        name: "x",
        repo: "https://github.com/Org/Repo",
        branch: "main",
        content: "",
      };
      assert.equal(
        buildGitHubTreeUrlForProject(p),
        "https://github.com/Org/Repo/tree/main",
      );
    });

    it("override de branche pour URL tree", () => {
      const p: ProjectContext = {
        name: "x",
        repo: "https://github.com/Org/Repo",
        branch: "main",
        content: "",
      };
      assert.equal(
        buildGitHubTreeUrlForProject(p, "backlog/01ARZ3NDEKTSV4RRFFQ69G5FAV-slug"),
        "https://github.com/Org/Repo/tree/backlog%2F01ARZ3NDEKTSV4RRFFQ69G5FAV-slug",
      );
    });

    it("accepte owner/repo court", () => {
      const p: ProjectContext = {
        name: "x",
        repo: "org/repo",
        branch: "feat/foo",
        content: "",
      };
      assert.equal(
        buildGitHubTreeUrlForProject(p),
        "https://github.com/org/repo/tree/feat%2Ffoo",
      );
    });
  });

  describe("trunk branches", () => {
    const orig = process.env.BRANCH_MISMATCH_TRUNK_BRANCHES;

    afterEach(() => {
      if (orig === undefined) delete process.env.BRANCH_MISMATCH_TRUNK_BRANCHES;
      else process.env.BRANCH_MISMATCH_TRUNK_BRANCHES = orig;
    });

    it("reconnaît main par défaut", () => {
      delete process.env.BRANCH_MISMATCH_TRUNK_BRANCHES;
      assert.ok(resolveTrunkBranchNames().includes("main"));
      assert.ok(isTrunkBranch("Main"));
    });

    it("respecte BRANCH_MISMATCH_TRUNK_BRANCHES", () => {
      process.env.BRANCH_MISMATCH_TRUNK_BRANCHES = "develop,staging";
      assert.ok(isTrunkBranch("develop"));
      assert.ok(!isTrunkBranch("main"));
    });
  });
});
