import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  parseLabelsFromGitHub,
  formatIssueCommentsForBrief,
  fetchIssueComments,
  pullIssuesFromGitHub,
  type GitHubCommentRaw,
} from "./github-sync.js";
import type { Backlog } from "./models.js";

// ─── parseLabelsFromGitHub ────────────────────────────────────────────────────

describe("parseLabelsFromGitHub", () => {
  it("tableau vide → null / null", () => {
    const r = parseLabelsFromGitHub([]);
    assert.strictEqual(r.priority, null);
    assert.strictEqual(r.size, null);
  });

  it("priority:must → MUST", () => {
    const r = parseLabelsFromGitHub([{ name: "priority:must" }]);
    assert.strictEqual(r.priority, "MUST");
  });

  it("priority:SHOULD (casse différente) → SHOULD", () => {
    const r = parseLabelsFromGitHub([{ name: "priority:SHOULD" }]);
    assert.strictEqual(r.priority, "SHOULD");
  });

  it("priority:could → COULD", () => {
    const r = parseLabelsFromGitHub([{ name: "priority:could" }]);
    assert.strictEqual(r.priority, "COULD");
  });

  it("priority:wont → WONT", () => {
    const r = parseLabelsFromGitHub([{ name: "priority:wont" }]);
    assert.strictEqual(r.priority, "WONT");
  });

  it("size:S → S", () => {
    const r = parseLabelsFromGitHub([{ name: "size:S" }]);
    assert.strictEqual(r.size, "S");
  });

  it("size:XL → XL", () => {
    const r = parseLabelsFromGitHub([{ name: "size:XL" }]);
    assert.strictEqual(r.size, "XL");
  });

  it("size:xl (casse) → XL", () => {
    const r = parseLabelsFromGitHub([{ name: "size:xl" }]);
    assert.strictEqual(r.size, "XL");
  });

  it("combiné priority + size", () => {
    const r = parseLabelsFromGitHub([{ name: "priority:must" }, { name: "size:M" }]);
    assert.strictEqual(r.priority, "MUST");
    assert.strictEqual(r.size, "M");
  });

  it("labels inconnus ignorés", () => {
    const r = parseLabelsFromGitHub([{ name: "bug" }, { name: "help wanted" }]);
    assert.strictEqual(r.priority, null);
    assert.strictEqual(r.size, null);
  });

  it("plusieurs labels priority → premier retenu", () => {
    const r = parseLabelsFromGitHub([{ name: "priority:must" }, { name: "priority:could" }]);
    assert.strictEqual(r.priority, "MUST");
  });
});

// ─── formatIssueCommentsForBrief ─────────────────────────────────────────────

describe("formatIssueCommentsForBrief", () => {
  it("tableau vide → chaîne vide", () => {
    assert.strictEqual(formatIssueCommentsForBrief(42, []), "");
  });

  it("un commentaire → contient le titre, le login et le corps", () => {
    const comment: GitHubCommentRaw = {
      id: 1,
      body: "Super feature !",
      user: { login: "alice" },
      created_at: "2026-05-10T08:00:00Z",
    };
    const result = formatIssueCommentsForBrief(42, [comment]);
    assert.ok(result.includes("## Commentaires GitHub (#42)"));
    assert.ok(result.includes("@alice"));
    assert.ok(result.includes("Super feature !"));
    assert.ok(result.includes("2026-05-10"));
  });

  it("commentaire avec body null → _(vide)_", () => {
    const comment: GitHubCommentRaw = {
      id: 2,
      body: null,
      user: { login: "bob" },
      created_at: "2026-05-10T09:00:00Z",
    };
    const result = formatIssueCommentsForBrief(7, [comment]);
    assert.ok(result.includes("_(vide)_"));
  });

  it("commentaire avec user null → login inconnu", () => {
    const comment: GitHubCommentRaw = {
      id: 3,
      body: "test",
      user: null,
      created_at: "2026-05-10T10:00:00Z",
    };
    const result = formatIssueCommentsForBrief(7, [comment]);
    assert.ok(result.includes("@inconnu"));
  });
});

// ─── fetchIssueComments ───────────────────────────────────────────────────────

describe("fetchIssueComments", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("200 → retourne le tableau de commentaires", async () => {
    const payload: GitHubCommentRaw[] = [
      { id: 1, body: "hello", user: { login: "x" }, created_at: "2026-01-01T00:00:00Z" },
    ];
    let capturedUrl = "";
    global.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify(payload), { status: 200 });
    };

    const result = await fetchIssueComments("https://github.com/acme/repo", "token", 42);
    assert.deepStrictEqual(result, payload);
    assert.ok(capturedUrl.includes("/repos/acme/repo/issues/42/comments"));
  });

  it("403 → retourne [] sans throw", async () => {
    global.fetch = async () => new Response("forbidden", { status: 403 });

    const result = await fetchIssueComments("https://github.com/acme/repo", "token", 5);
    assert.deepStrictEqual(result, []);
  });

  it("URL GitHub invalide → retourne [] sans throw", async () => {
    const result = await fetchIssueComments("https://gitlab.com/acme/repo", "token", 1);
    assert.deepStrictEqual(result, []);
  });
});

// ─── pullIssuesFromGitHub ─────────────────────────────────────────────────────

function makeBacklog(overrides: Partial<Backlog> = {}): Backlog {
  return {
    version: 2,
    lastUpdated: "2026-01-01T00:00:00Z",
    issues: [],
    backlogDocumentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ...overrides,
  };
}

describe("pullIssuesFromGitHub", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockGithubIssues(issues: object[]) {
    global.fetch = async () => new Response(JSON.stringify(issues), { status: 200 });
  }

  it("GitHub closed + backlog todo → status done", async () => {
    mockGithubIssues([
      { number: 10, title: "Fix X", state: "closed", labels: [], body: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ]);

    const backlog = makeBacklog({
      issues: [
        {
          id: "I-001",
          title: "Fix X",
          description: "",
          status: "todo",
          priority: "MUST",
          size: "S",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
          pipelineRun: null,
          githubIssueNumber: 10,
          source: "top_down",
        },
      ],
    });

    const result = await pullIssuesFromGitHub(backlog, "https://github.com/acme/repo", "tok");
    assert.strictEqual(result.statusClosed, 1);
    assert.strictEqual(backlog.issues[0]!.status, "done");
    assert.ok(backlog.issues[0]!.completedAt);
  });

  it("GitHub closed + backlog in_progress → conflit, status inchangé", async () => {
    mockGithubIssues([
      { number: 11, title: "WIP", state: "closed", labels: [], body: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ]);

    const backlog = makeBacklog({
      issues: [
        {
          id: "I-002",
          title: "WIP",
          description: "",
          status: "in_progress",
          priority: "MUST",
          size: "M",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
          pipelineRun: null,
          githubIssueNumber: 11,
          source: "top_down",
        },
      ],
    });

    const result = await pullIssuesFromGitHub(backlog, "https://github.com/acme/repo", "tok");
    assert.strictEqual(result.conflicts, 1);
    assert.strictEqual(result.statusClosed, 0);
    assert.strictEqual(backlog.issues[0]!.status, "in_progress");
  });

  it("labels changés → backlog mis à jour", async () => {
    mockGithubIssues([
      {
        number: 20,
        title: "Label update",
        state: "open",
        labels: [{ name: "priority:should" }, { name: "size:L" }],
        body: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    ]);

    const backlog = makeBacklog({
      issues: [
        {
          id: "I-003",
          title: "Label update",
          description: "",
          status: "todo",
          priority: "MUST",
          size: "S",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
          pipelineRun: null,
          githubIssueNumber: 20,
          source: "top_down",
        },
      ],
    });

    const result = await pullIssuesFromGitHub(backlog, "https://github.com/acme/repo", "tok");
    assert.strictEqual(result.labelsUpdated, 1);
    assert.strictEqual(backlog.issues[0]!.priority, "SHOULD");
    assert.strictEqual(backlog.issues[0]!.size, "L");
  });

  it("issue sans correspondance + importNew true (défaut) → ajoutée au backlog", async () => {
    mockGithubIssues([
      { number: 99, title: "New from GitHub", state: "open", labels: [] },
    ]);

    const backlog = makeBacklog();
    const result = await pullIssuesFromGitHub(backlog, "https://github.com/acme/repo", "tok");
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(backlog.issues.length, 1);
    assert.strictEqual(backlog.issues[0]!.githubIssueNumber, 99);
  });

  it("issue sans correspondance + importNew false → ignorée", async () => {
    mockGithubIssues([
      { number: 99, title: "New from GitHub", state: "open", labels: [] },
    ]);

    const backlog = makeBacklog();
    const result = await pullIssuesFromGitHub(backlog, "https://github.com/acme/repo", "tok", {
      importNew: false,
    });
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(backlog.issues.length, 0);
  });

  it("PRs dans la réponse API → filtrées (non importées)", async () => {
    mockGithubIssues([
      { number: 55, title: "feat: some PR", state: "open", labels: [], pull_request: {} },
    ]);

    const backlog = makeBacklog();
    const result = await pullIssuesFromGitHub(backlog, "https://github.com/acme/repo", "tok");
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(backlog.issues.length, 0);
  });

  it("issue déjà done côté backlog → pas de double comptage", async () => {
    mockGithubIssues([
      { number: 30, title: "Done", state: "closed", labels: [] },
    ]);

    const backlog = makeBacklog({
      issues: [
        {
          id: "I-004",
          title: "Done",
          description: "",
          status: "done",
          priority: "MUST",
          size: "S",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-02T00:00:00Z",
          pipelineRun: null,
          githubIssueNumber: 30,
          source: "top_down",
        },
      ],
    });

    const result = await pullIssuesFromGitHub(backlog, "https://github.com/acme/repo", "tok");
    assert.strictEqual(result.statusClosed, 0);
    assert.strictEqual(result.noChange, 1);
    assert.strictEqual(backlog.issues[0]!.status, "done");
  });
});
