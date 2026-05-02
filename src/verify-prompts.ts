#!/usr/bin/env tsx
/**
 * Vérifie que chaque fichier src/prompts/<prompt>.md référencé par AGENT_DEFINITIONS existe.
 * Usage : npm run verify:prompts
 */

import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { expectedPromptBasenames } from "./agent-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, "prompts");
const expected = expectedPromptBasenames();

let failed = false;
for (const base of expected) {
  const path = resolve(promptsDir, `${base}.md`);
  if (!existsSync(path)) {
    console.error(`❌ Prompt manquant : ${path}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log(`✅ ${expected.length} fichier(s) prompt attendu(s), tous présents.`);
