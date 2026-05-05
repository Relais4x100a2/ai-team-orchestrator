import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { closeGitHubIssueWithComment, postIssueComment, closeGitHubIssue } from "./github-sync.js";

describe("closeGitHubIssueWithComment", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("issue ouverte : GET puis PATCH puis POST dans cet ordre", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "GET")
        return new Response(JSON.stringify({ state: "open" }), { status: 200 });
      if (method === "PATCH")
        return new Response(JSON.stringify({ state: "closed", state_reason: "completed" }), { status: 200 });
      if (method === "POST") return new Response(JSON.stringify({ id: 99 }), { status: 201 });
      return new Response("bad", { status: 500 });
    };

    await closeGitHubIssueWithComment("https://github.com/acme/foo", "tok", 42, "trace");

    assert.strictEqual(calls.length, 3);
    assert.match(calls[0]!.url, /\/repos\/acme\/foo\/issues\/42$/);
    assert.strictEqual(calls[0]!.method, "GET");
    assert.strictEqual(calls[1]!.method, "PATCH");
    assert.strictEqual(
      calls[1]!.body,
      JSON.stringify({ state: "closed", state_reason: "completed" }),
    );
    assert.match(calls[2]!.url, /\/repos\/acme\/foo\/issues\/42\/comments$/);
    assert.strictEqual(calls[2]!.method, "POST");
    assert.strictEqual(calls[2]!.body, JSON.stringify({ body: "trace" }));
  });

  it("issue déjà fermée : GET uniquement, pas de PATCH ni POST", async () => {
    const methods: string[] = [];
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ state: "closed" }), { status: 200 });
    };

    await closeGitHubIssueWithComment("https://github.com/acme/foo", "tok", 1, "c");
    assert.strictEqual(methods.length, 1);
    assert.strictEqual(methods[0], "GET");
  });

  it("GET 404 : aucun PATCH", async () => {
    const methods: string[] = [];
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response("nope", { status: 404 });
    };

    await closeGitHubIssueWithComment("https://github.com/acme/foo", "tok", 7, "c");
    assert.deepStrictEqual(methods, ["GET"]);
  });

  it("PATCH échoue : pas de POST commentaire", async () => {
    const methods: string[] = [];
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET")
        return new Response(JSON.stringify({ state: "open" }), { status: 200 });
      return new Response("forbidden", { status: 403 });
    };

    await closeGitHubIssueWithComment("https://github.com/acme/foo", "tok", 1, "c");
    assert.deepStrictEqual(methods, ["GET", "PATCH"]);
  });
});

describe("postIssueComment et closeGitHubIssue", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("postIssueComment utilise POST …/comments", async () => {
    let captured: { url: string; method?: string; body?: string } | undefined;
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return new Response("{}", { status: 201 });
    };

    const ok = await postIssueComment("o/r", "t", 3, "hello");
    assert.strictEqual(ok, true);
    assert.ok(captured?.url.endsWith("/repos/o/r/issues/3/comments"));
    assert.strictEqual(captured?.method, "POST");
    assert.strictEqual(captured?.body, JSON.stringify({ body: "hello" }));
  });

  it("closeGitHubIssue utilise PATCH avec state closed", async () => {
    let captured: { method?: string; body?: string } | undefined;
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const ok = await closeGitHubIssue("o/r", "t", 9, "not_planned");
    assert.strictEqual(ok, true);
    assert.strictEqual(captured?.method, "PATCH");
    assert.strictEqual(
      captured?.body,
      JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    );
  });
});
