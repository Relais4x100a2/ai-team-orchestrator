import { describe, it } from "node:test";
import assert from "node:assert";
import {
  detectQAVerdict,
  detectSecurityVerdict,
  extractQAVerdictSection,
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

  it("reconnaît les formulations françaises courantes", () => {
    assert.strictEqual(
      detectQAVerdict(
        "### Verdict\n\nJe **demande des changements** sur la validation des entrées."
      ),
      "REQUEST_CHANGES"
    );
    assert.strictEqual(
      detectQAVerdict("Synthèse : **changements requis** avant merge."),
      "REQUEST_CHANGES"
    );
    assert.strictEqual(
      detectQAVerdict("Décision finale : corrections requises sur les tests."),
      "REQUEST_CHANGES"
    );
  });

  it("priorise VERDICT: REQUEST_CHANGES (ligne dédiée)", () => {
    assert.strictEqual(
      detectQAVerdict(
        "VERDICT: REQUEST_CHANGES\n\n### Verdict\n[APPROVE] (placeholder)"
      ),
      "REQUEST_CHANGES"
    );
  });

  it("priorise VERDICT: APPROVE quand aucune contradiction explicite", () => {
    assert.strictEqual(
      detectQAVerdict(
        "VERDICT: **APPROVE**\n\nQuelques remarques mineures sans blocage."
      ),
      "APPROVE"
    );
  });

  it("ignore « changements requis » lorsque la formulation est négée", () => {
    assert.strictEqual(
      detectQAVerdict(
        "### Verdict\n\nPas de changements requis pour cette PR mineure."
      ),
      "APPROVE"
    );
  });

  it("respecte REQUEST_CHANGES sur la ligne même avec marqueurs markdown", () => {
    assert.strictEqual(
      detectQAVerdict("VERDICT: **`REQUEST_CHANGES`** suite du rapport."),
      "REQUEST_CHANGES"
    );
  });

  it("ignore « changements requis » uniquement dans un bloc de code (scan corps)", () => {
    const rapport = `### Verdict\nApprouvé, pas de blocage.\n\nExemple de liste :\n\`\`\`\nchangements requis sur le module fictif\n\`\`\``;
    assert.strictEqual(detectQAVerdict(rapport), "APPROVE");
  });
});

describe("extractQAVerdictSection", () => {
  it("extrait le corps jusqu’au prochain titre de même niveau", () => {
    const md = `# T\n\n### Synthèse\n\nbla\n### 🏁 Verdict\n\nContenu verdict ici.\n### Suite\n\nautre`;
    assert.strictEqual(
      extractQAVerdictSection(md),
      "Contenu verdict ici."
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
