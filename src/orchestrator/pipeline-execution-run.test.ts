import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveRunStatus } from "./pipeline-execution-run.js";

describe("resolveRunStatus", () => {
  it("success when no escalation and no medium notes", () => {
    assert.equal(resolveRunStatus(false, false, false, "APPROVED"), "success");
  });

  it("partial when qaEscalated", () => {
    assert.equal(resolveRunStatus(true, false, false, "APPROVED"), "partial");
  });

  it("partial when securityEscalated", () => {
    assert.equal(resolveRunStatus(false, true, false, "APPROVED"), "partial");
  });

  it("partial when mediumSecurityNotes and last verdict is MEDIUM_ISSUES", () => {
    assert.equal(resolveRunStatus(false, false, true, "MEDIUM_ISSUES"), "partial");
  });

  it("partial when mediumSecurityNotes and last verdict is CRITICAL_ISSUES", () => {
    assert.equal(resolveRunStatus(false, false, true, "CRITICAL_ISSUES"), "partial");
  });

  it("success when mediumSecurityNotes but last verdict is APPROVED (MEDIUM overridden)", () => {
    assert.equal(resolveRunStatus(false, false, true, "APPROVED"), "success");
  });

  it("partial when mediumSecurityNotes and last verdict is null", () => {
    assert.equal(resolveRunStatus(false, false, true, null), "partial");
  });
});
