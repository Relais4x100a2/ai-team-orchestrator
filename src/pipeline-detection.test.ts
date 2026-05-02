import { describe, it } from "node:test";
import assert from "node:assert";
import {
  detectQAVerdict,
  detectSecurityVerdict,
} from "./pipeline-detection.js";

describe("detectQAVerdict", () => {
  it("approuve quand aucun motif request changes", () => {
    assert.strictEqual(detectQAVerdict("LGTM"), "APPROVE");
  });

  it("demande des changements si « request changes » apparaît", () => {
    assert.strictEqual(
      detectQAVerdict('La PR est bien mais "**Request changes**" sur les tests.'),
      "REQUEST_CHANGES"
    );
  });

  it("reconnaît request_changes snake_case", () => {
    assert.strictEqual(
      detectQAVerdict("Verdict : request_changes sur le handler."),
      "REQUEST_CHANGES"
    );
  });
});

describe("detectSecurityVerdict", () => {
  it("approve si rapport sans alerte nominale", () => {
    assert.strictEqual(detectSecurityVerdict("Rien à signaler."), "APPROVED");
  });

  it("critique si vulnérabilités critiques (texte français)", () => {
    assert.strictEqual(
      detectSecurityVerdict(
        "### Synthèse\n\n🚨 vulnérabilités critiques détectées sur l'auth."
      ),
      "CRITICAL_ISSUES"
    );
  });

  it("milieu si vulnérabilités moyennes", () => {
    assert.strictEqual(
      detectSecurityVerdict(
        "⚠️ vulnérabilités moyennes : rate limit incomplet."
      ),
      "MEDIUM_ISSUES"
    );
  });
});
