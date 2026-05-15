import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { resolve } from "path";
import {
  getPipelineNextResumeError,
  getPipelineSubcommandError,
  pipelineNextCliOptions,
} from "./cli.js";

describe("getPipelineSubcommandError", () => {
  it("accepte next et backlog", () => {
    assert.equal(getPipelineSubcommandError("next"), null);
    assert.equal(getPipelineSubcommandError("backlog"), null);
  });

  it("rejette full et les sous-commandes inconnues", () => {
    const err = getPipelineSubcommandError("full");
    assert.ok(err);
    assert.match(err, /--pipeline attend 'next' ou 'backlog forward\|backward'/);
  });
});

describe("getPipelineNextResumeError", () => {
  it("accepte architect, dev, security et qa", () => {
    for (const step of ["architect", "dev", "security", "qa"] as const) {
      assert.equal(getPipelineNextResumeError(step), null);
    }
    assert.equal(getPipelineNextResumeError(undefined), null);
  });

  it("rejette pm et redteam_reflection", () => {
    const err = getPipelineNextResumeError("pm");
    assert.ok(err);
    assert.match(err, /--resume-from avec --pipeline next/);
    assert.match(err, /utiliser --pipeline backlog/);
  });
});

describe("pipelineNextCliOptions", () => {
  it("transmet resumeFrom à pipelineNext", () => {
    assert.deepEqual(pipelineNextCliOptions("dev"), { resumeFrom: "dev" });
    assert.deepEqual(pipelineNextCliOptions(undefined), { resumeFrom: undefined });
  });
});

describe("CLI pipeline (processus)", () => {
  it("rejette --pipeline full via le binaire CLI", () => {
    const entry = resolve(process.cwd(), "src/orchestrator.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--pipeline", "full"],
      {
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "test-cli-key" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /--pipeline attend 'next' ou 'backlog forward\|backward'/);
  });
});

describe("--sprint option parsing", () => {
  it("rejette --sprint sans valeur via le binaire CLI", () => {
    const entry = resolve(process.cwd(), "src/orchestrator.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--sprint"],
      {
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "test-cli-key" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /--sprint nécessite un ULID/);
  });

  it("rejette --sprint avec un format non-ULID via le binaire CLI", () => {
    const entry = resolve(process.cwd(), "src/orchestrator.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--sprint", "not-a-valid-ulid"],
      {
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "test-cli-key" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /format ULID invalide/);
  });
});

describe("--from-sprint option parsing", () => {
  it("rejette --from-sprint sans valeur via le binaire CLI", () => {
    const entry = resolve(process.cwd(), "src/orchestrator.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--from-sprint"],
      {
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "test-cli-key" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /--from-sprint nécessite un ULID/);
  });

  it("rejette --from-sprint avec un format non-ULID via le binaire CLI", () => {
    const entry = resolve(process.cwd(), "src/orchestrator.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--from-sprint", "pas-un-ulid"],
      {
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "test-cli-key" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /format ULID invalide/);
  });
});
