import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueBacklogClosureForRunStatus } from "./pipeline-next-closure.js";

describe("issueBacklogClosureForRunStatus", () => {
  const now = "2026-05-14T08:00:00.000Z";

  it("marque done sur run success", () => {
    assert.deepEqual(issueBacklogClosureForRunStatus("success", now), {
      status: "done",
      completedAt: now,
      logLabel: "DONE",
    });
  });

  it("laisse in_progress sur run partial", () => {
    assert.deepEqual(issueBacklogClosureForRunStatus("partial", now), {
      status: "in_progress",
      completedAt: null,
      logLabel: "PARTIEL",
    });
  });

  it("laisse in_progress sur run failed", () => {
    assert.deepEqual(issueBacklogClosureForRunStatus("failed", now), {
      status: "in_progress",
      completedAt: null,
      logLabel: "PARTIEL",
    });
  });
});
