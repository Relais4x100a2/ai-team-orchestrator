import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSafeRelativeProjectPath,
  extractHandoffSection,
  isDevPipelineOutputTooWeak,
  warnIfHandoffFallback,
} from "./paths-and-env.js";

describe("assertSafeRelativeProjectPath", () => {
  it("rejette un chemin avec segment .. (même si path.normalize le replierait)", () => {
    assert.throws(() => assertSafeRelativeProjectPath("a/../b", "x"), /\.\./);
  });
});

describe("warnIfHandoffFallback", () => {
  it("n'émet pas d'avertissement quand le texte source est vide", () => {
    const warns: unknown[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args[0]);
    try {
      warnIfHandoffFallback("Test", "   ", "## M", "");
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.length, 0);
  });

  it("n'émet pas d'avertissement quand le handoff est présent", () => {
    const warns: unknown[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args[0]);
    try {
      const text = "## Handoff Dev — Architecture\n- ok";
      const extracted = extractHandoffSection(text, "## Handoff Dev — Architecture");
      warnIfHandoffFallback("Test", text, "## Handoff Dev — Architecture", extracted);
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.length, 0);
  });

  it("émet un avertissement quand le texte est non vide mais le marqueur est absent", () => {
    const warns: unknown[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args[0]);
    try {
      warnIfHandoffFallback("Étape X", "corps sans marqueur", "## Handoff Dev — Architecture", "");
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.length, 1);
    assert.match(String(warns[0]), /Étape X/);
    assert.match(String(warns[0]), /## Handoff Dev — Architecture/);
  });
});

describe("isDevPipelineOutputTooWeak", () => {
  it("considère insuffisant un texte vide", () => {
    assert.equal(isDevPipelineOutputTooWeak(""), true);
    assert.equal(isDevPipelineOutputTooWeak("   \n"), true);
  });

  it("considère insuffisant un texte court sans handoff ni PR", () => {
    assert.equal(isDevPipelineOutputTooWeak("ok", {}), true);
    assert.equal(isDevPipelineOutputTooWeak("x".repeat(40), {}), true);
  });

  it("accepte un texte assez long sans handoff ni PR", () => {
    assert.equal(isDevPipelineOutputTooWeak(`${"a".repeat(79)}\nlast`, {}), false);
  });

  it("accepte une PR même si le texte est court", () => {
    assert.equal(isDevPipelineOutputTooWeak("x", { prUrl: "https://github.com/o/r/pull/1" }), false);
  });

  it("accepte le handoff même si le corps est court", () => {
    const t = "## Handoff Security & QA\n- **PR** : https://github.com/o/r/pull/2\n";
    assert.equal(isDevPipelineOutputTooWeak(t, {}), false);
  });
});
