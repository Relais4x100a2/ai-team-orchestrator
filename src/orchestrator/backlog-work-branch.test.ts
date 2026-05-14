import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slugifyForGitBranch } from "./backlog-work-branch.js";

describe("slugifyForGitBranch", () => {
  it("accents et espaces → ASCII", () => {
    assert.equal(slugifyForGitBranch("Résumé Café 2024"), "resume-cafe-2024");
  });

  it("chaîne vide ou symboles seuls → backlog", () => {
    assert.equal(slugifyForGitBranch("   "), "backlog");
    assert.equal(slugifyForGitBranch("@@@"), "backlog");
  });
});
