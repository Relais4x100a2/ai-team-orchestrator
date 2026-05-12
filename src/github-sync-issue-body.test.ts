import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BacklogIssue } from "./models.js";
import { buildGitHubIssueBody } from "./github-sync.js";

const minimalIssue = (): BacklogIssue => ({
  id: "issue-001",
  title: "Titre",
  description: "Corps",
  status: "todo",
  priority: "MUST",
  size: "S",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  pipelineRun: null,
});

describe("buildGitHubIssueBody", () => {
  it("contient backlogDocumentId et chemin relatif", () => {
    const body = buildGitHubIssueBody(minimalIssue(), {
      backlogDocumentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      backlogRelativePath: ".ai-team-orchestrator/backlog.json",
    });
    assert.match(body, /01ARZ3NDEKTSV4RRFFQ69G5FAV/);
    assert.match(body, /\.ai-team-orchestrator\/backlog\.json/);
    assert.match(body, /issue-001/);
    assert.match(body, /\*\*Priorité :\*\* MUST/);
  });

  it("conserve le préfixe titre [issue-NNN] dans la signature id story", () => {
    const body = buildGitHubIssueBody(minimalIssue(), {
      backlogDocumentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      backlogRelativePath: "last-run/foo/backlog.json",
    });
    assert.match(body, /id story : `issue-001`/);
  });
});
