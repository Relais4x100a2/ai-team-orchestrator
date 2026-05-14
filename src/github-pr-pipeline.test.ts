import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertPullRequestRepoMatchesProject,
  fetchPullRequest,
  mergePullRequest,
  mergePullRequestAfterCi,
  parsePullRequestNumberFromUrl,
  resolveGithubMergeMethod,
  validatePullRequestForRun,
  waitForCommitChecksGreen,
  type PullRequestDetails,
} from "./github-pr-pipeline.js";

describe("parsePullRequestNumberFromUrl", () => {
  it("extrait un numéro PR", () => {
    assert.equal(parsePullRequestNumberFromUrl("https://github.com/acme/foo/pull/42"), 42);
    assert.equal(parsePullRequestNumberFromUrl("https://github.com/acme/foo/pull/42#issuecomment-1"), 42);
  });

  it("rejette new PR et URLs invalides", () => {
    assert.equal(
      parsePullRequestNumberFromUrl("https://github.com/acme/foo/pull/new/branch"),
      undefined,
    );
    assert.equal(parsePullRequestNumberFromUrl("https://github.com/acme/foo/tree/main"), undefined);
  });
});

describe("assertPullRequestRepoMatchesProject", () => {
  it("accepte le même dépôt", () => {
    assert.doesNotThrow(() =>
      assertPullRequestRepoMatchesProject(
        "https://github.com/acme/foo/pull/1",
        "https://github.com/acme/foo.git",
      ),
    );
  });

  it("rejette un autre dépôt", () => {
    assert.throws(
      () =>
        assertPullRequestRepoMatchesProject(
          "https://github.com/acme/other/pull/1",
          "https://github.com/acme/foo",
        ),
      /hors dépôt projet/,
    );
  });
});

describe("validatePullRequestForRun", () => {
  const basePr: PullRequestDetails = {
    number: 7,
    headRef: "backlog/01ARZ3NDEKTSV4RRFFQ69G5FAV-sprint",
    baseRef: "main",
    headSha: "abc",
    htmlUrl: "https://github.com/acme/foo/pull/7",
    headRepoFullName: "acme/foo",
    baseRepoFullName: "acme/foo",
    mergeable: true,
    mergeableState: "clean",
  };

  it("accepte head/base cohérents", () => {
    assert.doesNotThrow(() =>
      validatePullRequestForRun({
        pr: basePr,
        expectedBaseRef: "main",
        expectedHeadRef: basePr.headRef,
        backlogDocumentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    );
  });

  it("rejette fork et mauvais ULID", () => {
    assert.throws(
      () =>
        validatePullRequestForRun({
          pr: { ...basePr, headRepoFullName: "forker/foo" },
          expectedBaseRef: "main",
        }),
      /fork interdit/,
    );
    assert.throws(
      () =>
        validatePullRequestForRun({
          pr: { ...basePr, headRef: "backlog/OTHERULID000000000000000-sprint" },
          expectedBaseRef: "main",
          backlogDocumentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        }),
      /document backlog/,
    );
  });
});

describe("fetchPullRequest et mergePullRequest", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetchPullRequest mappe head/base", async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          number: 3,
          html_url: "https://github.com/acme/foo/pull/3",
          mergeable: true,
          mergeable_state: "clean",
          head: { ref: "feat", sha: "sha1", repo: { full_name: "acme/foo" } },
          base: { ref: "main", repo: { full_name: "acme/foo" } },
        }),
        { status: 200 },
      );
    const pr = await fetchPullRequest("acme/foo", "tok", 3);
    assert.equal(pr.headRef, "feat");
    assert.equal(pr.baseRef, "main");
  });

  it("mergePullRequest envoie PUT merge", async () => {
    const calls: { method?: string; body?: string }[] = [];
    global.fetch = async (_input, init) => {
      calls.push({ method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ merged: true }), { status: 200 });
    };
    await mergePullRequest("acme/foo", "tok", 5, "squash");
    assert.equal(calls[0]!.method, "PUT");
    assert.equal(calls[0]!.body, JSON.stringify({ merge_method: "squash" }));
  });
});

describe("waitForCommitChecksGreen", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("réussit quand statut success et aucun check en attente", async () => {
    global.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "success" }), { status: 200 });
      }
      return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
    };
    await waitForCommitChecksGreen("acme/foo", "tok", "sha", {
      timeoutMs: 1000,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
  });

  it("échoue sur check-run en failure", async () => {
    global.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "pending" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          check_runs: [{ status: "completed", conclusion: "failure" }],
        }),
        { status: 200 },
      );
    };
    await assert.rejects(
      () =>
        waitForCommitChecksGreen("acme/foo", "tok", "sha", {
          timeoutMs: 1000,
          pollIntervalMs: 1,
          sleep: async () => {},
        }),
      /CI en échec/,
    );
  });
});

describe("mergePullRequestAfterCi", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("re-fetch PR après CI avant merge", async () => {
    let pullGets = 0;
    global.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/pulls/9") && method === "GET") {
        pullGets++;
        const sha = pullGets >= 2 ? "sha-final" : "sha-initial";
        return new Response(
          JSON.stringify({
            number: 9,
            html_url: "https://github.com/acme/foo/pull/9",
            mergeable: true,
            mergeable_state: "clean",
            head: { ref: "feat", sha, repo: { full_name: "acme/foo" } },
            base: { ref: "main", repo: { full_name: "acme/foo" } },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "success" }), { status: 200 });
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (method === "PUT") {
        return new Response(JSON.stringify({ merged: true }), { status: 200 });
      }
      return new Response("bad", { status: 500 });
    };
    const pr = await mergePullRequestAfterCi("acme/foo", "tok", 9, {
      timeoutMs: 1000,
      pollIntervalMs: 1,
      method: "squash",
      sleep: async () => {},
    });
    assert.equal(pr.headSha, "sha-final");
    assert.ok(pullGets >= 2);
  });
});

describe("resolveGithubMergeMethod", () => {
  it("défaut squash", () => {
    assert.equal(resolveGithubMergeMethod({}), "squash");
    assert.equal(resolveGithubMergeMethod({ GITHUB_MERGE_METHOD: "rebase" }), "rebase");
  });
});
