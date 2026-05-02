import { describe, it } from "node:test";
import assert from "node:assert";
import { createAgentConfig, expectedPromptBasenames } from "./agent-config.js";

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
  it("utilise MODEL_STRONG / MODEL_FAST quand défini après trim et applique défaut sinon", () => {
    const cfg = createAgentConfig({
      MODEL_STRONG: "  strong-model ",
      MODEL_FAST: "fast-model",
    });
    assert.strictEqual(cfg.pm.model, "strong-model");
    assert.strictEqual(cfg.qa.model, "fast-model");
    assert.strictEqual(cfg.architect.model, "strong-model");
    assert.strictEqual(cfg.dev.model, "fast-model");
  });

  it("retombe aux modèles par défaut pour chaîne vide après trim ou absentes", () => {
    const emptyTrim = createAgentConfig({
      MODEL_STRONG: "   ",
      MODEL_FAST: "\t",
    });
    assert.strictEqual(emptyTrim.pm.model, "gpt-5-mini");
    assert.strictEqual(emptyTrim.qa.model, "composer-2");

    const omitted = createAgentConfig({});
    assert.strictEqual(omitted.pm.model, "gpt-5-mini");
    assert.strictEqual(omitted.qa.model, "composer-2");
  });

  it("expose toujours tous les champs prompts / description par rôle", () => {
    const cfg = createAgentConfig({});
    assert.strictEqual(cfg.pm.promptFile, "product-manager");
    assert.ok(cfg.redteam.description.length > 0);
  });
});
