import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  findBlockingPaths,
  resolveCheckoutStashPaths,
  stashBlockingPaths,
  type GitRunner,
} from "./git-checkout-guard.js";

// ---------------------------------------------------------------------------
// resolveCheckoutStashPaths
// ---------------------------------------------------------------------------

describe("resolveCheckoutStashPaths", () => {
  const KEY = "ORCHESTRATOR_CHECKOUT_STASH_PATHS";

  afterEach(() => {
    delete process.env[KEY];
  });

  it("retourne [backlog.json] par défaut (pas d'env)", () => {
    delete process.env[KEY];
    assert.deepEqual(resolveCheckoutStashPaths(), ["backlog.json"]);
  });

  it("parse une valeur unique depuis l'env", () => {
    process.env[KEY] = "custom.json";
    assert.deepEqual(resolveCheckoutStashPaths(), ["custom.json"]);
  });

  it("parse plusieurs chemins séparés par virgule", () => {
    process.env[KEY] = "foo.json,bar.json";
    assert.deepEqual(resolveCheckoutStashPaths(), ["foo.json", "bar.json"]);
  });

  it("supprime les espaces autour des chemins", () => {
    process.env[KEY] = " foo.json , bar.json ";
    assert.deepEqual(resolveCheckoutStashPaths(), ["foo.json", "bar.json"]);
  });

  it("ignore les entrées vides (virgules superflues)", () => {
    process.env[KEY] = "foo.json,,bar.json,";
    assert.deepEqual(resolveCheckoutStashPaths(), ["foo.json", "bar.json"]);
  });

  it("retourne [backlog.json] si l'env est une chaîne vide", () => {
    process.env[KEY] = "";
    assert.deepEqual(resolveCheckoutStashPaths(), ["backlog.json"]);
  });
});

// ---------------------------------------------------------------------------
// findBlockingPaths
// ---------------------------------------------------------------------------

describe("findBlockingPaths", () => {
  it("retourne [] si candidates est vide (aucun appel git)", () => {
    const git = mock.fn<GitRunner>();
    const result = findBlockingPaths("/repo", "ai-team/pipeline", [], git);
    assert.deepEqual(result, []);
    assert.equal(git.mock.callCount(), 0);
  });

  it("retourne [] si aucun candidat n'apparaît dans git status --porcelain", () => {
    const git = mock.fn<GitRunner>(() => "");
    const result = findBlockingPaths("/repo", "ai-team/pipeline", ["backlog.json"], git);
    assert.deepEqual(result, []);
  });

  it("détecte un fichier modifié dans le working tree ( M)", () => {
    const git = mock.fn<GitRunner>(() => " M backlog.json");
    const result = findBlockingPaths("/repo", "ai-team/pipeline", ["backlog.json"], git);
    assert.deepEqual(result, ["backlog.json"]);
  });

  it("détecte un fichier staged (M )", () => {
    const git = mock.fn<GitRunner>(() => "M  backlog.json");
    const result = findBlockingPaths("/repo", "ai-team/pipeline", ["backlog.json"], git);
    assert.deepEqual(result, ["backlog.json"]);
  });

  it("détecte un fichier staged+modifié (MM)", () => {
    const git = mock.fn<GitRunner>(() => "MM backlog.json");
    const result = findBlockingPaths("/repo", "ai-team/pipeline", ["backlog.json"], git);
    assert.deepEqual(result, ["backlog.json"]);
  });

  it("filtre les candidats non présents dans le porcelain", () => {
    const git = mock.fn<GitRunner>(() => " M backlog.json\n M src/foo.py");
    const result = findBlockingPaths("/repo", "ai-team/pipeline", ["backlog.json", "other.json"], git);
    assert.deepEqual(result, ["backlog.json"]);
  });

  it("retourne plusieurs candidats bloquants", () => {
    const git = mock.fn<GitRunner>(() => " M backlog.json\n M extra.json");
    const result = findBlockingPaths("/repo", "ai-team/pipeline", ["backlog.json", "extra.json"], git);
    assert.deepEqual(result, ["backlog.json", "extra.json"]);
  });

  it("gère les lignes vides dans la sortie porcelain", () => {
    const git = mock.fn<GitRunner>(() => "\n M backlog.json\n\n");
    const result = findBlockingPaths("/repo", "ai-team/pipeline", ["backlog.json"], git);
    assert.deepEqual(result, ["backlog.json"]);
  });

  it("appelle git status avec --porcelain et --untracked-files=no", () => {
    const git = mock.fn<GitRunner>(() => "");
    findBlockingPaths("/repo", "ai-team/pipeline", ["backlog.json"], git);
    const [repoDir, args] = git.mock.calls[0].arguments;
    assert.equal(repoDir, "/repo");
    assert.ok(args.includes("--porcelain"));
    assert.ok(args.includes("--untracked-files=no"));
  });
});

// ---------------------------------------------------------------------------
// stashBlockingPaths
// ---------------------------------------------------------------------------

describe("stashBlockingPaths", () => {
  it("n'appelle pas git si paths est vide", () => {
    const git = mock.fn<GitRunner>(() => "");
    stashBlockingPaths("/repo", [], git);
    assert.equal(git.mock.callCount(), 0);
  });

  it("appelle git stash push avec le message et le chemin", () => {
    const git = mock.fn<GitRunner>(() => "");
    stashBlockingPaths("/repo", ["backlog.json"], git);
    assert.equal(git.mock.callCount(), 1);
    const [repoDir, args] = git.mock.calls[0].arguments;
    assert.equal(repoDir, "/repo");
    assert.ok(args.includes("stash"));
    assert.ok(args.includes("push"));
    assert.ok(args.includes("-m"));
    assert.ok(args.some((a) => a.includes("ai-team-orchestrator")));
    assert.ok(args.includes("--"));
    assert.ok(args.includes("backlog.json"));
  });

  it("inclut tous les chemins dans un seul appel stash", () => {
    const git = mock.fn<GitRunner>(() => "");
    stashBlockingPaths("/repo", ["backlog.json", "extra.json"], git);
    assert.equal(git.mock.callCount(), 1);
    const [, args] = git.mock.calls[0].arguments;
    assert.ok(args.includes("backlog.json"));
    assert.ok(args.includes("extra.json"));
  });
});
