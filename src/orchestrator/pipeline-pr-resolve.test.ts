import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { describe, it } from "node:test";
import { join } from "path";
import type { ProjectContext } from "../models.js";
import { LAST_RUN_BASE_DIR } from "./paths-and-env.js";
import { resolvePipelinePrUrl } from "./pipeline-pr-resolve.js";
import type { PipelineExecutionOutcome } from "./pipeline-types.js";
import { LAST_RUN_CONTEXT_FILE } from "./run-context.js";
import { emptyOrchestratorSession } from "./session.js";
import type { OrchestratorSession } from "./session.js";

function sessionWithLastRun(slug: string, subdir?: string): OrchestratorSession {
  const session: OrchestratorSession = {
    ...emptyOrchestratorSession(),
    activeProjectSlug: slug,
    agentOutputRelativeSubdir: subdir ?? null,
  };
  return session;
}

describe("resolvePipelinePrUrl", () => {
  it("devGate : priorité texte dev puis detectedPrUrl puis run-context", () => {
    const session = sessionWithLastRun("proj-a");
    const fromText = resolvePipelinePrUrl(session, {
      mode: "devGate",
      implementation: "PR https://github.com/org/repo/pull/1",
    });
    assert.equal(fromText, "https://github.com/org/repo/pull/1");

    const fromArg = resolvePipelinePrUrl(session, {
      mode: "devGate",
      implementation: "sans url",
      detectedPrUrl: "https://github.com/org/repo/pull/2",
    });
    assert.equal(fromArg, "https://github.com/org/repo/pull/2");

    const root = join(LAST_RUN_BASE_DIR, "proj-b");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, LAST_RUN_CONTEXT_FILE),
      JSON.stringify({ latestPrUrl: "https://github.com/org/repo/pull/3" }),
    );
    const sessionCtx = sessionWithLastRun("proj-b");
    const fromCtx = resolvePipelinePrUrl(sessionCtx, {
      mode: "devGate",
      implementation: "vide",
    });
    assert.equal(fromCtx, "https://github.com/org/repo/pull/3");
  });

  it("devGate : undefined si aucune source", () => {
    const session = sessionWithLastRun("proj-empty");
    assert.equal(
      resolvePipelinePrUrl(session, { mode: "devGate", implementation: "pas de pr" }),
      undefined,
    );
  });

  it("mergePilot : lit dev.md puis outcome puis run-context", () => {
    const dir = mkdtempSync(join(tmpdir(), "ato-pr-resolve-"));
    const project: ProjectContext = {
      name: "X",
      repo: "https://github.com/a/b",
      branch: "main",
      content: "",
      localPath: dir,
      projectDataDir: join(dir, ".ai-team-orchestrator"),
    };
    mkdirSync(join(project.projectDataDir!, "runs", "doc", "issue-1"), { recursive: true });
    writeFileSync(
      join(project.projectDataDir!, "runs", "doc", "issue-1", "dev.md"),
      "Voir https://github.com/a/b/pull/9",
    );
    const session: OrchestratorSession = {
      ...emptyOrchestratorSession(),
      activeProject: project,
      activeProjectSlug: "slug",
      agentOutputRelativeSubdir: "runs/doc/issue-1",
    };
    const outcome: PipelineExecutionOutcome = {
      runStatus: "success",
      qaEscalated: false,
      securityEscalated: false,
      mediumSecurityNotes: false,
      lastQaVerdict: "APPROVE",
      lastSecurityVerdict: "APPROVED",
      detectedPrUrl: "https://github.com/a/b/pull/99",
    };
    assert.equal(
      resolvePipelinePrUrl(session, { mode: "mergePilot", outcome }),
      "https://github.com/a/b/pull/9",
    );
  });

  it("mergePilot : throw si aucune PR résoluble", () => {
    const session = sessionWithLastRun("proj-merge-fail");
    const outcome: PipelineExecutionOutcome = {
      runStatus: "success",
      qaEscalated: false,
      securityEscalated: false,
      mediumSecurityNotes: false,
      lastQaVerdict: "APPROVE",
      lastSecurityVerdict: "APPROVED",
    };
    assert.throws(
      () => resolvePipelinePrUrl(session, { mode: "mergePilot", outcome }),
      /aucune URL de PR/,
    );
  });
});
