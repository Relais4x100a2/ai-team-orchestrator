import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";

import { parseBacklogJson, parsePipelineRunsFile, resolveBriefFilePath } from "../src/models.js";

const validIssue = {
  id: "issue-001",
  title: "Foo",
  description: "desc",
  status: "todo",
  priority: "MUST",
  size: "M",
  createdAt: "2026-05-01T12:00:00.000Z",
  updatedAt: "2026-05-01T12:00:00.000Z",
  completedAt: null,
  pipelineRun: null,
};

describe("parseBacklogJson", () => {
  it("accepte un backlog minimal valide", () => {
    const b = parseBacklogJson({
      version: 1,
      lastUpdated: "2026-05-01T12:00:00.000Z",
      issues: [validIssue],
    });
    assert.equal(b.issues.length, 1);
    assert.equal(b.issues[0].id, "issue-001");
  });

  it("rejette un id dupliqué", () => {
    assert.throws(
      () =>
        parseBacklogJson({
          version: 1,
          lastUpdated: "2026-05-01T12:00:00.000Z",
          issues: [validIssue, { ...validIssue, title: "Other" }],
        }),
      /dupliqué/
    );
  });

  it("rejette un statut inconnu", () => {
    assert.throws(
      () =>
        parseBacklogJson({
          version: 1,
          lastUpdated: "2026-05-01T12:00:00.000Z",
          issues: [{ ...validIssue, status: "invalid" }],
        }),
      /status/
    );
  });
});

describe("parsePipelineRunsFile", () => {
  it("valide un fichier de runs minimal", () => {
    const file = parsePipelineRunsFile({
      version: 1,
      runs: [
        {
          id: "run-1",
          brief: "x",
          resumeFrom: null,
          qaIterations: 0,
          securityIterations: 0,
          status: "success",
          startedAt: "2026-05-01T12:00:00.000Z",
          finishedAt: "2026-05-01T12:01:00.000Z",
        },
      ],
    });
    assert.equal(file.runs[0].id, "run-1");
  });

  it("accepte les nouvelles étapes resumeFrom (security, redteam_reflection)", () => {
    const file = parsePipelineRunsFile({
      version: 1,
      runs: [
        {
          id: "run-2",
          brief: "x",
          resumeFrom: "security",
          qaIterations: 1,
          securityIterations: 2,
          status: "partial",
          startedAt: "2026-05-01T12:00:00.000Z",
          finishedAt: "2026-05-01T12:01:00.000Z",
        },
        {
          id: "run-3",
          brief: "y",
          resumeFrom: "redteam_reflection",
          qaIterations: 0,
          securityIterations: 0,
          status: "success",
          startedAt: "2026-05-01T12:00:00.000Z",
          finishedAt: "2026-05-01T12:01:00.000Z",
        },
      ],
    });
    assert.equal(file.runs.length, 2);
  });
});

describe("resolveBriefFilePath", () => {
  it("résout un chemin relatif au cwd", () => {
    const cwd = "/home/u/proj";
    assert.equal(resolveBriefFilePath("docs/brief.md", cwd), join(cwd, "docs", "brief.md"));
  });

  it("normalise un chemin absolu", () => {
    const p = resolveBriefFilePath("/tmp/foo.md", "/any");
    assert.ok(p.endsWith("foo.md") || p.includes("foo.md"));
  });
});
