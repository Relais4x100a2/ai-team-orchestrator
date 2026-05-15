import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { extractOpenQuestions, promptOpenQuestionsWithStreams } from "./open-questions.js";

describe("extractOpenQuestions", () => {
  it("retourne [] quand aucune question", () => {
    assert.deepEqual(extractOpenQuestions("Voici ma sortie.\n\nPas de question."), []);
  });

  it("extrait le contenu d'une section '### Question ouverte'", () => {
    const text = `Voici le backlog.

### Question ouverte (éviter de deviner)

Souhaitez-vous scinder le commit 1 en deux issues, ou garder une seule issue comme ci-dessus ?

## Synthèse`;
    const result = extractOpenQuestions(text);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes("Souhaitez-vous scinder"));
  });

  it("extrait plusieurs sections '### Question ouverte'", () => {
    const text = `### Question ouverte\n\nPremière question ?\n\n### Question ouverte\n\nDeuxième question ?`;
    const result = extractOpenQuestions(text);
    assert.equal(result.length, 2);
  });

  it("n'extrait pas les paragraphes hors section même s'ils se terminent par '?'", () => {
    const text = `Analyse complète.\n\nLong contexte ici.\n\nVoulez-vous activer cette option ?\n\nConclusion.`;
    assert.deepEqual(extractOpenQuestions(text), []);
  });
});

describe("promptOpenQuestionsWithStreams", () => {
  it("retourne une chaîne formatée avec les réponses", async () => {
    const fakeInput = Readable.from(["Garder une seule issue.\n"]);
    const fakeOutput = new PassThrough();
    const result = await promptOpenQuestionsWithStreams(
      ["Souhaitez-vous scinder le commit 1 ?"],
      fakeInput,
      fakeOutput,
    );
    assert.ok(result.includes("## Réponses aux questions ouvertes"));
    assert.ok(result.includes("Souhaitez-vous scinder"));
    assert.ok(result.includes("Garder une seule issue."));
  });
});
