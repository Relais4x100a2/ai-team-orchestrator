import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractOpenQuestions } from "./open-questions.js";

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

  it("fallback : extrait les paragraphes de fin se terminant par '?'", () => {
    const text = `Analyse complète.\n\nLong contexte ici.\n\nVoulez-vous activer cette option ?\n\nAutre paragraphe sans point d'interrogation.`;
    const result = extractOpenQuestions(text);
    assert.ok(result.some(q => q.includes("Voulez-vous activer")));
  });

  it("fallback : ignore les paragraphes sans '?'", () => {
    const text = `Voici un résumé.\n\nPas de question ici.\n\nConclusion finale.`;
    assert.deepEqual(extractOpenQuestions(text), []);
  });
});

import { createInterface } from "node:readline";
import { Readable } from "node:stream";

describe("promptOpenQuestions", () => {
  it("retourne une chaîne formatée avec les réponses", async () => {
    // Simuler une entrée utilisateur via un Readable
    const fakeInput = Readable.from(["Garder une seule issue.\n"]);
    // On ne peut pas mocker process.stdin directement — tester la logique via inject
    // On importe la version injectable (voir implémentation ci-dessous)
    const { promptOpenQuestionsWithStreams } = await import("./open-questions.js");
    const result = await promptOpenQuestionsWithStreams(
      ["Souhaitez-vous scinder le commit 1 ?"],
      fakeInput,
      process.stdout,
    );
    assert.ok(result.includes("## Réponses aux questions ouvertes"));
    assert.ok(result.includes("Souhaitez-vous scinder"));
    assert.ok(result.includes("Garder une seule issue."));
  });
});
