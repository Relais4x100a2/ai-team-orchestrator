import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertDevOutputSufficientForSecurityAndQA } from "./pipeline-dev-guards.js";
import { emptyOrchestratorSession } from "./session.js";

describe("assertDevOutputSufficientForSecurityAndQA", () => {
  it("throw si sortie dev faible sans PR", () => {
    assert.throws(
      () =>
        assertDevOutputSufficientForSecurityAndQA(
          emptyOrchestratorSession(),
          "   ",
          undefined,
          "test garde-fou",
        ),
      /Sortie développeur insuffisante/,
    );
  });

  it("ne throw pas si une URL PR est présente", () => {
    assert.doesNotThrow(() =>
      assertDevOutputSufficientForSecurityAndQA(
        emptyOrchestratorSession(),
        "PR https://github.com/org/repo/pull/42",
        undefined,
        "test garde-fou",
      ),
    );
  });
});
