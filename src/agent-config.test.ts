import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createAgentConfig,
  expectedPromptBasenames,
  formatModelSelection,
  resolveRunModel,
} from "./agent-config.js";

describe("expectedPromptBasenames", () => {
  it("est triée et sans doublon (une entrée par promptFile distinct)", () => {
    const list = expectedPromptBasenames();
    const sorted = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepStrictEqual(list, sorted);

    const set = new Set(list);
    assert.strictEqual(
      set.size,
      list.length,
      `doublons possibles dans expectedPromptBasenames : ${JSON.stringify(list)}`
    );

    assert.ok(list.includes("product-manager"));
    assert.ok(list.includes("qa-engineer"));
  });
});

describe("createAgentConfig", () => {
  it("retourne les défauts codés (id + params) quand aucun env n'est défini", () => {
    const cfg = createAgentConfig({});
    assert.strictEqual(cfg.pm.model.id, "claude-sonnet-4-5");
    assert.ok(Array.isArray(cfg.pm.model.params) && cfg.pm.model.params!.length > 0);
    assert.strictEqual(cfg.dev.model.id, "composer-2");
    assert.strictEqual(cfg.security.model.id, "composer-2");
    assert.ok(cfg.security.model.params?.some(p => p.id === "fast" && p.value === "false"));
  });

  it("MODEL_<ROLE> surcharge le modèle d'un rôle précis (sans params)", () => {
    const cfg = createAgentConfig({ MODEL_PM: "gpt-5.5", MODEL_DEV: "composer-2" });
    assert.strictEqual(cfg.pm.model.id, "gpt-5.5");
    assert.strictEqual(cfg.pm.model.params, undefined);
    assert.strictEqual(cfg.dev.model.id, "composer-2");
    assert.strictEqual(cfg.architect.model.id, "claude-sonnet-4-5");
  });

  it("MODEL_STRONG surcharge tous les rôles « strong » si aucun override par rôle", () => {
    const cfg = createAgentConfig({ MODEL_STRONG: "gpt-5.5" });
    assert.strictEqual(cfg.pm.model.id, "gpt-5.5");
    assert.strictEqual(cfg.architect.model.id, "gpt-5.5");
    assert.strictEqual(cfg.security.model.id, "gpt-5.5");
    assert.strictEqual(cfg.dev.model.id, "composer-2");
  });

  it("MODEL_FAST surcharge tous les rôles « fast » si aucun override par rôle", () => {
    const cfg = createAgentConfig({ MODEL_FAST: "claude-haiku-4-5" });
    assert.strictEqual(cfg.dev.model.id, "claude-haiku-4-5");
    assert.strictEqual(cfg.qa.model.id, "claude-haiku-4-5");
    assert.strictEqual(cfg.pm.model.id, "claude-sonnet-4-5");
  });

  it("MODEL_<ROLE> a priorité sur MODEL_STRONG/MODEL_FAST", () => {
    const cfg = createAgentConfig({ MODEL_STRONG: "gpt-5.5", MODEL_PM: "claude-opus-4-7" });
    assert.strictEqual(cfg.pm.model.id, "claude-opus-4-7");
    assert.strictEqual(cfg.architect.model.id, "gpt-5.5");
  });

  it("chaîne vide ou whitespace dans env vars est ignoré (retombe au défaut)", () => {
    const cfg = createAgentConfig({ MODEL_STRONG: "   ", MODEL_PM: "\t" });
    assert.strictEqual(cfg.pm.model.id, "claude-sonnet-4-5");
    assert.strictEqual(cfg.architect.model.id, "claude-sonnet-4-5");
  });

  it("expose toujours tous les champs promptFile / description par rôle", () => {
    const cfg = createAgentConfig({});
    assert.strictEqual(cfg.pm.promptFile, "product-manager");
    assert.ok(cfg.security.description.length > 0);
    assert.strictEqual(cfg.redteam_reflection.promptFile, "red-team-reflection");
  });
});

describe("resolveRunModel", () => {
  it("applique la grille S (PM Haiku, architect Composer fast)", () => {
    const pm = resolveRunModel("pm", { issueSize: "S", frugal: false, env: {} });
    assert.strictEqual(pm.id, "claude-haiku-4-5");
    const arch = resolveRunModel("architect", { issueSize: "S", frugal: false, env: {} });
    assert.strictEqual(arch.id, "composer-2");
    assert.ok(arch.params?.some(p => p.id === "fast" && p.value === "true"));
  });

  it("taille L = défauts codés (Sonnet PM sans thinking)", () => {
    const pm = resolveRunModel("pm", { issueSize: "L", frugal: false, env: {} });
    assert.strictEqual(pm.id, "claude-sonnet-4-5");
    assert.ok(pm.params?.some(p => p.id === "thinking" && p.value === "false"));
  });

  it("security hors XL → composer-2 avec fast:false (thinking sur composer invalide pour l'API)", () => {
    const rt = resolveRunModel("security", { issueSize: "S", frugal: false, env: {} });
    assert.strictEqual(rt.id, "composer-2");
    assert.ok(rt.params?.some(p => p.id === "fast" && p.value === "false"));
    const rtl = resolveRunModel("security", { issueSize: "L", frugal: false, env: {} });
    assert.strictEqual(rtl.id, "composer-2");
    assert.ok(rtl.params?.some(p => p.id === "fast" && p.value === "false"));
  });

  it("taille XL (architect Opus, dev/qa Composer slow, security Sonnet)", () => {
    const arch = resolveRunModel("architect", { issueSize: "XL", frugal: false, env: {} });
    assert.strictEqual(arch.id, "claude-opus-4-7");
    const dev = resolveRunModel("dev", { issueSize: "XL", frugal: false, env: {} });
    assert.strictEqual(dev.id, "composer-2");
    assert.ok(dev.params?.some(p => p.id === "fast" && p.value === "false"));
    const rt = resolveRunModel("security", { issueSize: "XL", frugal: false, env: {} });
    assert.strictEqual(rt.id, "claude-sonnet-4-5");
  });

  it("MODEL_<ROLE> reste prioritaire sur la grille", () => {
    const pm = resolveRunModel("pm", {
      issueSize: "S",
      frugal: false,
      env: { MODEL_PM: "gpt-5.5" },
    });
    assert.strictEqual(pm.id, "gpt-5.5");
  });

  it("sans issueSize, ignore la grille (privacy Sonnet même si on ne passe pas issueSize)", () => {
    const p = resolveRunModel("privacy", { frugal: false, env: {} });
    assert.strictEqual(p.id, "claude-sonnet-4-5");
  });

  it("frugal force composer-2 même avec issueSize XL", () => {
    const arch = resolveRunModel("architect", { issueSize: "XL", frugal: true, env: {} });
    assert.strictEqual(arch.id, "composer-2");
    assert.ok(arch.params?.some(p => p.id === "fast" && p.value === "true"));
  });
});

describe("formatModelSelection", () => {
  it("retourne juste l'id quand pas de params", () => {
    assert.strictEqual(formatModelSelection({ id: "gpt-5.5" }), "gpt-5.5");
  });

  it("affiche l'id et les params entre parenthèses", () => {
    assert.strictEqual(
      formatModelSelection({
        id: "claude-sonnet-4-5",
        params: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }],
      }),
      "claude-sonnet-4-5 (thinking:true, effort:high)"
    );
  });
});
