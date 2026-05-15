import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Préfixe utilisé pour formater une réponse dans la sortie de `promptOpenQuestions`. */
export const ANSWER_PREFIX = "   → ";

/**
 * Extrait les questions ouvertes d'une sortie agent.
 * Détecte uniquement les sections explicites "### Question(s) ouverte(s)".
 */
export function extractOpenQuestions(text: string): string[] {
  const lines = text.split("\n");
  const questions: string[] = [];
  let inSection = false;
  let current: string[] = [];

  for (const line of lines) {
    if (/^###\s+Questions?\s+ouverte/i.test(line)) {
      if (inSection) {
        const q = current.join("\n").trim();
        if (q) questions.push(q);
      }
      inSection = true;
      current = [];
      continue;
    }
    if (inSection) {
      if (/^#{1,3}\s/.test(line) || line.trimEnd() === "---") {
        const q = current.join("\n").trim();
        if (q) questions.push(q);
        inSection = false;
        current = [];
        continue;
      }
      current.push(line);
    }
  }
  if (inSection) {
    const q = current.join("\n").trim();
    if (q) questions.push(q);
  }

  return questions;
}

/** Version injectable pour les tests — prend des streams en paramètre. */
export async function promptOpenQuestionsWithStreams(
  questions: string[],
  input: NodeJS.ReadableStream | Readable,
  output: NodeJS.WritableStream | Writable,
): Promise<string> {
  const rl = createInterface({ input, output, terminal: false });
  const lines: string[] = ["## Réponses aux questions ouvertes", ""];

  const askLine = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = await askLine(`\n❓ Question ${i + 1}/${questions.length} :\n${q}\n\n→ Ta réponse : `);
    lines.push(`${i + 1}. ${q}`);
    lines.push(`${ANSWER_PREFIX}${answer.trim()}`);
    lines.push("");
  }

  rl.close();
  return lines.join("\n").trim();
}

/** Version production — utilise process.stdin / process.stdout. */
export async function promptOpenQuestions(questions: string[]): Promise<string> {
  return promptOpenQuestionsWithStreams(questions, process.stdin, process.stdout);
}
