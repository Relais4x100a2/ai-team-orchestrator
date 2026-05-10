import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectContext } from "../models.js";
import { buildQAPipelineContext, buildSecurityImplementationContext } from "./context-builders.js";
import type { OrchestratorSession } from "./session.js";

describe("context-builders (prompts cloud)", () => {
  it("n’inclut pas le chemin last-run/run-context.json dans le contexte sécurité", () => {
    const project: ProjectContext = {
      name: "P",
      repo: "https://github.com/a/b",
      branch: "main",
      content: "",
    };
    const session: OrchestratorSession = {
      activeProject: project,
      activeProjectSlug: "slug",
    };
    const out = buildSecurityImplementationContext(session, "## impl\n");
    assert.match(out, /Dernière URL branche/s);
    assert.doesNotMatch(out, /last-run\/run-context\.json/);
  });

  it("n’inclut pas le chemin last-run/run-context.json dans le contexte QA", () => {
    const project: ProjectContext = {
      name: "P",
      repo: "https://github.com/a/b",
      branch: "main",
      content: "",
    };
    const session: OrchestratorSession = {
      activeProject: project,
      activeProjectSlug: "slug",
    };
    const out = buildQAPipelineContext(session, "## qa\n");
    assert.doesNotMatch(out, /last-run\/run-context\.json/);
  });
});
