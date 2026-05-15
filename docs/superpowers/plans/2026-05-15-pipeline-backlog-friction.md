# Pipeline Backlog Friction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four friction points in `pipeline backlog forward/backward`: open questions pause, code access for agents, and multi-sprint backlog storage.

**Architecture:** Four independent surgical changes all wired into `pipeline-backlog.ts`. Two new pure modules (`open-questions.ts`, `code-snapshot.ts`, `sprint-io.ts`) keep the new logic testable in isolation. `OrchestratorSession` gains `activeSprintId` to route backlog I/O to the right sprint directory.

**Tech Stack:** TypeScript, Node.js, `node:readline`, `node:child_process` (`execFileSync`), `ulid`, `tsx --test` (node:test + node:assert/strict)

---

## File Map

| File | Action |
|---|---|
| `src/orchestrator/open-questions.ts` | Create — `extractOpenQuestions`, `promptOpenQuestions` |
| `src/orchestrator/open-questions.test.ts` | Create — unit tests |
| `src/orchestrator/code-snapshot.ts` | Create — `buildCodeSnapshot` |
| `src/orchestrator/code-snapshot.test.ts` | Create — unit tests |
| `src/orchestrator/sprint-io.ts` | Create — `createSprint`, `loadSprintIndex`, `saveSprintIndex`, `updateSprintIssueCount`, `migrateLegacyBacklogToSprint` |
| `src/orchestrator/sprint-io.test.ts` | Create — unit tests |
| `src/orchestrator/session.ts` | Modify — add `activeSprintId: string \| null` |
| `src/orchestrator/backlog-io.ts` | Modify — `resolveBacklogPath` checks `activeSprintId` |
| `src/orchestrator/backlog-io.test.ts` | Modify — add sprint path test |
| `src/orchestrator/pipeline-backlog.ts` | Modify — wire all three mechanisms |
| `src/orchestrator/cli.ts` | Modify — `--sprint` option, sprint setup before `pipelineNext`, sprint list for `backlog` flag |
| `src/orchestrator/cli-pipeline.test.ts` | Modify — add `--sprint` parsing test |
| `src/prompts/product-manager.md` | Modify — add code rule |
| `src/prompts/data-architect.md` | Modify — add code rule |
| `src/prompts/red-team-reflection.md` | Modify — add code rule |
| `package.json` | Modify — add 3 new test files to `scripts.test` |

---

## Task 1 — `open-questions.ts` : extract + prompt interactif

**Files:**
- Create: `src/orchestrator/open-questions.ts`
- Create: `src/orchestrator/open-questions.test.ts`

- [ ] **Step 1.1 — Écrire le test pour `extractOpenQuestions` (section explicite)**

```typescript
// src/orchestrator/open-questions.test.ts
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
```

- [ ] **Step 1.2 — Lancer le test pour vérifier qu'il échoue**

```bash
cd /home/guillaumecayeux/code_dev/ai-team-orchestrator
npx tsx --test src/orchestrator/open-questions.test.ts
```

Résultat attendu : erreur de module non trouvé ou `extractOpenQuestions is not a function`.

- [ ] **Step 1.3 — Implémenter `extractOpenQuestions`**

```typescript
// src/orchestrator/open-questions.ts

/**
 * Extrait les questions ouvertes d'une sortie agent.
 * Cherche en priorité les sections "### Question ouverte".
 * Fallback : paragraphes de fin se terminant par "?".
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

  if (questions.length > 0) return questions;

  // Fallback : paragraphes de fin (derniers 1500 chars) se terminant par "?"
  const tail = text.slice(-1500);
  return tail
    .split(/\n\n+/)
    .filter((p) => p.trim().endsWith("?"))
    .map((p) => p.trim())
    .filter(Boolean);
}
```

- [ ] **Step 1.4 — Relancer le test `extractOpenQuestions`**

```bash
npx tsx --test src/orchestrator/open-questions.test.ts
```

Résultat attendu : tous les tests `extractOpenQuestions` passent.

- [ ] **Step 1.5 — Écrire le test pour `promptOpenQuestions`**

Ajouter dans `src/orchestrator/open-questions.test.ts` :

```typescript
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
```

- [ ] **Step 1.6 — Implémenter `promptOpenQuestionsWithStreams` et `promptOpenQuestions`**

Compléter `src/orchestrator/open-questions.ts` :

```typescript
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

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
    lines.push(`   → ${answer.trim()}`);
    lines.push("");
  }

  rl.close();
  return lines.join("\n").trim();
}

/** Version production — utilise process.stdin / process.stdout. */
export async function promptOpenQuestions(questions: string[]): Promise<string> {
  return promptOpenQuestionsWithStreams(questions, process.stdin, process.stdout);
}
```

- [ ] **Step 1.7 — Relancer tous les tests du fichier**

```bash
npx tsx --test src/orchestrator/open-questions.test.ts
```

Résultat attendu : tous les tests passent.

- [ ] **Step 1.8 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 1.9 — Ajouter le fichier de test à `package.json`**

Dans `package.json`, dans la clé `"test"` du `"scripts"`, ajouter `src/orchestrator/open-questions.test.ts` à la liste existante (après `src/orchestrator/cli-pipeline.test.ts`).

- [ ] **Step 1.10 — Lancer la suite complète**

```bash
npm test
```

Résultat attendu : tous les tests existants passent + les nouveaux.

- [ ] **Step 1.11 — Commit**

```bash
git add src/orchestrator/open-questions.ts src/orchestrator/open-questions.test.ts package.json
git commit -m "feat: module open-questions — extract et prompt interactif"
```

---

## Task 2 — Wirer `open-questions` dans `pipeline-backlog.ts`

**Files:**
- Modify: `src/orchestrator/pipeline-backlog.ts`

- [ ] **Step 2.1 — Ajouter l'import en tête de `pipeline-backlog.ts`**

En haut du fichier, après les imports existants :

```typescript
import { extractOpenQuestions, promptOpenQuestions } from "./open-questions.js";
```

- [ ] **Step 2.2 — Définir un helper local pour collecter les questions et les injecter**

Ajouter juste avant `pipelineBacklogReflection` :

```typescript
/**
 * Si la sortie contient des questions ouvertes et que stdin est interactif,
 * pause et collecte les réponses. Retourne une chaîne à préfixer dans additionalContext.
 */
async function collectOpenAnswers(agentOutput: string): Promise<string> {
  const questions = extractOpenQuestions(agentOutput);
  if (questions.length === 0 || !process.stdin.isTTY) {
    if (questions.length > 0) {
      console.warn(`\n⚠️  ${questions.length} question(s) ouverte(s) détectée(s) — mode non-interactif, ignorée(s).`);
    }
    return "";
  }
  console.log(`\n💬 ${questions.length} question(s) ouverte(s) de l'agent — répondre pour affiner l'étape suivante.`);
  return promptOpenQuestions(questions);
}
```

- [ ] **Step 2.3 — Modifier `pipelineBacklogReflection` : injecter les réponses après PM initial**

Localiser le bloc :
```typescript
  const specs = await runAgent(session, "pm", pmTask, {
    additionalContext: brief,
    frugal,
    cloud: resolveCloudMode(session, "pm"),
  });

  const architecture = await runArchitectForBacklogReflection(session, specs, frugal);
```

Remplacer par :
```typescript
  const specs = await runAgent(session, "pm", pmTask, {
    additionalContext: brief,
    frugal,
    cloud: resolveCloudMode(session, "pm"),
  });

  const pmAnswers = await collectOpenAnswers(specs);
  const specsWithAnswers = pmAnswers ? `${pmAnswers}\n\n---\n\n${specs}` : specs;

  const architecture = await runArchitectForBacklogReflection(session, specsWithAnswers, frugal);
```

- [ ] **Step 2.4 — Collecter les réponses après architect, AVANT l'appel redteam**

Entre la ligne `const architecture = await runArchitectForBacklogReflection(...)` et le bloc `runAgent("redteam_reflection", ...)`, ajouter :

```typescript
  const archAnswers = await collectOpenAnswers(architecture);
  const architectureWithAnswers = archAnswers ? `${archAnswers}\n\n---\n\n${architecture}` : architecture;
```

Puis dans l'`additionalContext` du `runAgent` redteam, remplacer :
```typescript
      additionalContext: `## Backlog\n${specs}\n\n## Vision architecture\n${architecture}`,
```
Par :
```typescript
      additionalContext: `## Backlog\n${specsWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}`,
```

- [ ] **Step 2.5 — Collecter les réponses après redteam, AVANT le PM de synthèse**

Entre la ligne `const reflection = await runAgent(session, "redteam_reflection", ...)` et le bloc du PM de synthèse, ajouter :

```typescript
  const reflectionAnswers = await collectOpenAnswers(reflection);
  const reflectionWithAnswers = reflectionAnswers ? `${reflectionAnswers}\n\n---\n\n${reflection}` : reflection;
```

Dans l'`additionalContext` du PM de synthèse, remplacer :
```typescript
      additionalContext: `## Backlog initial (PM)\n${specs}\n\n## Vision architecture\n${architecture}\n\n## Défis et ajustements Red Team\n${reflection}`,
```

Par :
```typescript
      additionalContext: `## Backlog initial (PM)\n${specsWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}\n\n## Défis et ajustements Red Team\n${reflectionWithAnswers}`,
```

- [ ] **Step 2.6 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 2.7 — Lancer les tests**

```bash
npm test
```

Résultat attendu : tous les tests passent (pas de tests sur `pipelineBacklogReflection` directement — logique d'intégration).

- [ ] **Step 2.8 — Commit**

```bash
git add src/orchestrator/pipeline-backlog.ts
git commit -m "feat: pause interactive pour les questions ouvertes dans pipeline backlog"
```

---

## Task 3 — `code-snapshot.ts` + règle dans les prompts

**Files:**
- Create: `src/orchestrator/code-snapshot.ts`
- Create: `src/orchestrator/code-snapshot.test.ts`
- Modify: `src/prompts/product-manager.md`
- Modify: `src/prompts/data-architect.md`
- Modify: `src/prompts/red-team-reflection.md`

- [ ] **Step 3.1 — Écrire les tests pour `buildCodeSnapshot`**

```typescript
// src/orchestrator/code-snapshot.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it } from "node:test";
import { buildCodeSnapshot } from "./code-snapshot.js";

describe("buildCodeSnapshot", () => {
  it("retourne le contenu de context.md quand il existe dans projectDataDir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "snap-"));
    const dataDir = join(tmp, ".ai-team-orchestrator");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "context.md"), "# Contexte\nStacktech : TypeScript.", "utf-8");
    const result = buildCodeSnapshot(tmp, dataDir);
    assert.ok(result.includes("Contexte"));
    assert.ok(result.includes("TypeScript"));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("retourne un snapshot git quand context.md est absent", () => {
    // Utilise le repo de l'orchestrateur lui-même comme localPath de test
    const localPath = process.cwd();
    const result = buildCodeSnapshot(localPath, undefined);
    // Doit contenir au moins une des sections attendues
    assert.ok(
      result.includes("Commits récents") || result.includes("Structure") || result.includes("Snapshot"),
    );
  });

  it("tronque à ~2000 caractères max", () => {
    const tmp = mkdtempSync(join(tmpdir(), "snap-"));
    const dataDir = join(tmp, ".ai-team-orchestrator");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "context.md"), "x".repeat(5000), "utf-8");
    const result = buildCodeSnapshot(tmp, dataDir);
    assert.ok(result.length <= 2100); // marge pour le label
    rmSync(tmp, { recursive: true, force: true });
  });

  it("retourne une chaîne non vide même si git échoue", () => {
    const tmp = mkdtempSync(join(tmpdir(), "snap-"));
    // Pas de repo git ici — les execFileSync doivent être silencieux
    const result = buildCodeSnapshot(tmp, undefined);
    assert.ok(typeof result === "string");
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3.2 — Lancer le test pour vérifier qu'il échoue**

```bash
npx tsx --test src/orchestrator/code-snapshot.test.ts
```

Résultat attendu : module non trouvé.

- [ ] **Step 3.3 — Implémenter `buildCodeSnapshot`**

```typescript
// src/orchestrator/code-snapshot.ts
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const SNAPSHOT_MAX_CHARS = 2000;

function trimSnapshot(text: string): string {
  if (text.length <= SNAPSHOT_MAX_CHARS) return text;
  return text.slice(0, SNAPSHOT_MAX_CHARS) + "\n\n[…tronqué]";
}

function tryExec(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

/**
 * Construit un snapshot léger du code pour l'injecter en contexte agent.
 * Priorité : context.md dans projectDataDir. Fallback : git log + diff stat + arbre.
 */
export function buildCodeSnapshot(localPath: string, projectDataDir?: string): string {
  if (projectDataDir) {
    const contextPath = resolve(projectDataDir, "context.md");
    if (existsSync(contextPath)) {
      const content = readFileSync(contextPath, "utf-8").trim();
      if (content) {
        return trimSnapshot(`## Contexte code (context.md)\n\n${content}`);
      }
    }
  }

  const parts: string[] = ["## Snapshot code"];

  const log = tryExec("git", ["log", "--oneline", "-7"], localPath);
  if (log) parts.push(`### Commits récents\n\`\`\`\n${log}\n\`\`\``);

  const stat = tryExec("git", ["diff", "--stat", "HEAD~3"], localPath);
  if (stat) parts.push(`### Fichiers récemment modifiés\n\`\`\`\n${stat}\n\`\`\``);

  const tree = tryExec(
    "find",
    [".", "-maxdepth", "2", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/dist/*"],
    localPath,
  );
  if (tree) parts.push(`### Structure (2 niveaux)\n\`\`\`\n${tree}\n\`\`\``);

  return trimSnapshot(parts.join("\n\n"));
}
```

- [ ] **Step 3.4 — Relancer les tests**

```bash
npx tsx --test src/orchestrator/code-snapshot.test.ts
```

Résultat attendu : tous les tests passent.

- [ ] **Step 3.5 — Ajouter la règle code dans `product-manager.md`**

Ouvrir `src/prompts/product-manager.md`. Localiser la section `## Règles` (ou à défaut la dernière section). Ajouter juste avant la dernière ligne `---` (ou en fin de fichier) :

```markdown
## Règle code existant

Si le projet dispose d'un chemin local (`local_path`), explore la structure du code (fichiers récemment modifiés, arbre de répertoires, README) **avant** de produire ta réponse. Tes conclusions doivent refléter la réalité du dépôt, pas seulement le brief fourni.
```

- [ ] **Step 3.6 — Ajouter la même règle dans `data-architect.md`**

Même ajout, même emplacement, dans `src/prompts/data-architect.md`.

- [ ] **Step 3.7 — Ajouter la même règle dans `red-team-reflection.md`**

Même ajout dans `src/prompts/red-team-reflection.md`, juste avant la ligne `---` finale.

- [ ] **Step 3.8 — Vérifier que les prompts sont toujours référencés correctement**

```bash
npm run verify:prompts
```

Résultat attendu : `✅ Tous les fichiers prompts sont présents.` (ou équivalent).

- [ ] **Step 3.9 — Ajouter le fichier de test à `package.json`**

Ajouter `src/orchestrator/code-snapshot.test.ts` à la liste des fichiers dans `scripts.test` de `package.json`.

- [ ] **Step 3.10 — Lancer la suite complète**

```bash
npm test
```

Résultat attendu : tous les tests passent.

- [ ] **Step 3.11 — Commit**

```bash
git add src/orchestrator/code-snapshot.ts src/orchestrator/code-snapshot.test.ts \
        src/prompts/product-manager.md src/prompts/data-architect.md src/prompts/red-team-reflection.md \
        package.json
git commit -m "feat: snapshot code injecté dans les agents backlog + règle prompt code existant"
```

---

## Task 4 — Wirer le snapshot code dans `pipeline-backlog.ts`

**Files:**
- Modify: `src/orchestrator/pipeline-backlog.ts`

- [ ] **Step 4.1 — Ajouter l'import**

En tête de `pipeline-backlog.ts`, ajouter :

```typescript
import { buildCodeSnapshot } from "./code-snapshot.js";
```

- [ ] **Step 4.2 — Construire le snapshot en début de `pipelineBacklogReflection`**

Au début de la fonction `pipelineBacklogReflection`, juste après la récupération de `frugal` :

```typescript
  const codeSnapshot = session.activeProject?.localPath
    ? buildCodeSnapshot(session.activeProject.localPath, session.activeProject.projectDataDir ?? undefined)
    : "";

  const withSnapshot = (ctx: string): string =>
    codeSnapshot ? `## Contexte code du projet\n\n${codeSnapshot}\n\n---\n\n${ctx}` : ctx;
```

- [ ] **Step 4.3 — Préfixer le snapshot dans chaque `additionalContext`**

Remplacer les `additionalContext` dans les 4 appels `runAgent` de `pipelineBacklogReflection` :

1. **PM initial** :
   ```typescript
   additionalContext: withSnapshot(brief),
   ```

2. **`runArchitectForBacklogReflection`** (dans `pipeline-backlog.ts`, la fonction appelle `runAgent` avec `additionalContext: specs`) — passer `withSnapshot(specsWithAnswers)` à la place de `specsWithAnswers` :
   ```typescript
   const architecture = await runArchitectForBacklogReflection(session, withSnapshot(specsWithAnswers), frugal);
   ```
   
   **Note :** `runArchitectForBacklogReflection` est une fonction exportée qui prend `specs: string` directement dans son `additionalContext`. Passer la valeur enrichie à l'appel est suffisant — pas besoin de modifier la fonction elle-même.

3. **redteam_reflection** :
   ```typescript
   additionalContext: withSnapshot(`## Backlog\n${specsWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}`),
   ```

4. **PM synthèse** :
   ```typescript
   additionalContext: withSnapshot(`## Backlog initial (PM)\n${specsWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}\n\n## Défis et ajustements Red Team\n${reflectionWithAnswers}`),
   ```

- [ ] **Step 4.4 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 4.5 — Lancer les tests**

```bash
npm test
```

Résultat attendu : tous les tests passent.

- [ ] **Step 4.6 — Commit**

```bash
git add src/orchestrator/pipeline-backlog.ts
git commit -m "feat: injection snapshot code dans les agents du pipeline backlog"
```

---

## Task 5 — `sprint-io.ts` + `session.ts`

**Files:**
- Create: `src/orchestrator/sprint-io.ts`
- Create: `src/orchestrator/sprint-io.test.ts`
- Modify: `src/orchestrator/session.ts`

- [ ] **Step 5.1 — Écrire les tests pour `sprint-io`**

```typescript
// src/orchestrator/sprint-io.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, it } from "node:test";
import {
  createSprint,
  loadSprintIndex,
  migrateLegacyBacklogToSprint,
  resolveSprintIndexPath,
  updateSprintIssueCount,
} from "./sprint-io.js";

describe("createSprint", () => {
  it("crée le répertoire du sprint et met à jour index.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    const id = createSprint(tmp, "forward", "Test brief");
    assert.ok(id.length === 26, "ULID attendu");
    assert.ok(existsSync(resolve(tmp, "sprints", id)));
    const index = loadSprintIndex(tmp);
    assert.ok(index !== null);
    assert.equal(index!.activeSprint, id);
    assert.equal(index!.sprints.length, 1);
    assert.equal(index!.sprints[0].direction, "forward");
    assert.equal(index!.sprints[0].brief, "Test brief");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("le deuxième sprint s'ajoute à l'index et devient actif", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    const id1 = createSprint(tmp, "forward", "Sprint 1");
    const id2 = createSprint(tmp, "backward", "Sprint 2");
    const index = loadSprintIndex(tmp);
    assert.equal(index!.activeSprint, id2);
    assert.equal(index!.sprints.length, 2);
    assert.ok(index!.sprints.some(s => s.id === id1));
    assert.ok(index!.sprints.some(s => s.id === id2));
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("loadSprintIndex", () => {
  it("retourne null quand index.json absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    assert.equal(loadSprintIndex(tmp), null);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("updateSprintIssueCount", () => {
  it("met à jour issueCount du sprint actif", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    const id = createSprint(tmp, "forward", "Brief");
    updateSprintIssueCount(tmp, id, 5);
    const index = loadSprintIndex(tmp);
    assert.equal(index!.sprints[0].issueCount, 5);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("migrateLegacyBacklogToSprint", () => {
  it("déplace backlog.json dans sprints/<ULID>/ et crée index.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    writeFileSync(resolve(tmp, "backlog.json"), '{"version":2,"issues":[]}', "utf-8");
    migrateLegacyBacklogToSprint(tmp);
    // backlog.json ne doit plus être à la racine
    assert.ok(!existsSync(resolve(tmp, "backlog.json")));
    // index.json doit exister
    const indexPath = resolveSprintIndexPath(tmp);
    assert.ok(existsSync(indexPath));
    const index = loadSprintIndex(tmp);
    assert.ok(index !== null);
    const sprintId = index!.activeSprint;
    assert.ok(existsSync(resolve(tmp, "sprints", sprintId, "backlog.json")));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ne fait rien si sprints/ existe déjà", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    mkdirSync(resolve(tmp, "sprints"), { recursive: true });
    writeFileSync(resolve(tmp, "backlog.json"), "{}", "utf-8");
    migrateLegacyBacklogToSprint(tmp);
    // backlog.json toujours à la racine
    assert.ok(existsSync(resolve(tmp, "backlog.json")));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ne fait rien si backlog.json absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    migrateLegacyBacklogToSprint(tmp); // ne doit pas lancer d'exception
    assert.ok(!existsSync(resolve(tmp, "sprints")));
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 5.2 — Lancer pour vérifier l'échec**

```bash
npx tsx --test src/orchestrator/sprint-io.test.ts
```

Résultat attendu : module non trouvé.

- [ ] **Step 5.3 — Implémenter `sprint-io.ts`**

```typescript
// src/orchestrator/sprint-io.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";
import { ulid } from "ulid";
import { mkdirWithDefaultGitignoreIfNeeded } from "./paths-and-env.js";

export type SprintEntry = {
  id: string;
  createdAt: string;
  direction: "forward" | "backward";
  brief: string;
  issueCount: number;
};

export type SprintIndex = {
  activeSprint: string;
  sprints: SprintEntry[];
};

export function resolveSprintsDir(projectDataDir: string): string {
  return resolve(projectDataDir, "sprints");
}

export function resolveSprintIndexPath(projectDataDir: string): string {
  return resolve(resolveSprintsDir(projectDataDir), "index.json");
}

export function loadSprintIndex(projectDataDir: string): SprintIndex | null {
  const path = resolveSprintIndexPath(projectDataDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SprintIndex;
  } catch {
    return null;
  }
}

export function saveSprintIndex(projectDataDir: string, index: SprintIndex): void {
  const dir = resolveSprintsDir(projectDataDir);
  mkdirWithDefaultGitignoreIfNeeded(dir);
  writeFileSync(resolveSprintIndexPath(projectDataDir), JSON.stringify(index, null, 2), "utf-8");
}

export function createSprint(
  projectDataDir: string,
  direction: "forward" | "backward",
  brief: string,
): string {
  const id = ulid();
  mkdirSync(resolve(resolveSprintsDir(projectDataDir), id), { recursive: true });
  const existing = loadSprintIndex(projectDataDir);
  const entry: SprintEntry = {
    id,
    createdAt: new Date().toISOString(),
    direction,
    brief: brief.slice(0, 200),
    issueCount: 0,
  };
  saveSprintIndex(projectDataDir, {
    activeSprint: id,
    sprints: [...(existing?.sprints ?? []), entry],
  });
  return id;
}

export function updateSprintIssueCount(
  projectDataDir: string,
  sprintId: string,
  count: number,
): void {
  const index = loadSprintIndex(projectDataDir);
  if (!index) return;
  const entry = index.sprints.find((s) => s.id === sprintId);
  if (entry) entry.issueCount = count;
  saveSprintIndex(projectDataDir, index);
}

/**
 * Migre un `backlog.json` existant à la racine de `projectDataDir` vers `sprints/<ULID>/backlog.json`.
 * Sans effet si `sprints/` existe déjà ou si `backlog.json` est absent.
 */
export function migrateLegacyBacklogToSprint(projectDataDir: string): void {
  const legacyPath = resolve(projectDataDir, "backlog.json");
  if (!existsSync(legacyPath)) return;
  if (existsSync(resolveSprintsDir(projectDataDir))) return;
  const id = ulid();
  const sprintDir = resolve(resolveSprintsDir(projectDataDir), id);
  mkdirSync(sprintDir, { recursive: true });
  renameSync(legacyPath, resolve(sprintDir, "backlog.json"));
  saveSprintIndex(projectDataDir, {
    activeSprint: id,
    sprints: [
      {
        id,
        createdAt: new Date().toISOString(),
        direction: "forward",
        brief: "(migré depuis backlog.json)",
        issueCount: 0,
      },
    ],
  });
  console.log(`   🔄 Migration backlog : backlog.json → sprints/${id}/backlog.json`);
}
```

- [ ] **Step 5.4 — Relancer les tests sprint-io**

```bash
npx tsx --test src/orchestrator/sprint-io.test.ts
```

Résultat attendu : tous les tests passent.

- [ ] **Step 5.5 — Ajouter `activeSprintId` dans `session.ts`**

Remplacer le contenu de `src/orchestrator/session.ts` par :

```typescript
import type { ProjectContext } from "../models.js";

/** État runtime du CLI (projet actif). Toujours passé en argument — pas de singleton mutable. */
export type OrchestratorSession = {
  activeProject: ProjectContext | null;
  activeProjectSlug: string | null;
  /** Si défini, doit correspondre à `backlog.backlogDocumentId` après migration (`loadBacklog`). */
  cliBacklogDocumentId: string | null;
  /**
   * Sous-répertoire relatif au répertoire de données pour les sorties agents
   * (ex. `runs/<backlogDocumentId>/<issueId>` pendant `pipeline next`).
   */
  agentOutputRelativeSubdir: string | null;
  /** Branche Git locale + `startingRef` cloud pour l'exécution ticket (`backlog/...`). */
  backlogWorkBranch: string | null;
  /** Sprint actif — route les lectures/écritures du backlog vers `sprints/<id>/backlog.json`. */
  activeSprintId: string | null;
};

export function emptyOrchestratorSession(): OrchestratorSession {
  return {
    activeProject: null,
    activeProjectSlug: null,
    cliBacklogDocumentId: null,
    agentOutputRelativeSubdir: null,
    backlogWorkBranch: null,
    activeSprintId: null,
  };
}
```

- [ ] **Step 5.6 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 5.7 — Ajouter le fichier de test à `package.json`**

Ajouter `src/orchestrator/sprint-io.test.ts` dans la liste de `scripts.test`.

- [ ] **Step 5.8 — Lancer la suite complète**

```bash
npm test
```

Résultat attendu : tous les tests passent.

- [ ] **Step 5.9 — Commit**

```bash
git add src/orchestrator/sprint-io.ts src/orchestrator/sprint-io.test.ts \
        src/orchestrator/session.ts package.json
git commit -m "feat: sprint-io — gestion des sprints + activeSprintId dans session"
```

---

## Task 6 — `backlog-io.ts` : router vers le bon sprint

**Files:**
- Modify: `src/orchestrator/backlog-io.ts`
- Modify: `src/orchestrator/backlog-io.test.ts`

- [ ] **Step 6.1 — Écrire le test pour la résolution sprint**

Dans `src/orchestrator/backlog-io.test.ts`, ajouter après le `describe("resolveBacklogPath")` existant :

```typescript
  it("renvoie sprints/<sprintId>/backlog.json quand activeSprintId est défini", () => {
    const dataDir = "/tmp/foo/.ai-team-orchestrator";
    const project: ProjectContext = {
      name: "P",
      repo: "https://github.com/a/b",
      branch: "main",
      content: "",
      localPath: "/tmp/foo",
      projectDataDir: dataDir,
    };
    const session: OrchestratorSession = {
      ...emptyOrchestratorSession(),
      activeProject: project,
      activeProjectSlug: "slug",
      activeSprintId: "01SPRINTTEST001ULID00000000",
    };
    assert.equal(
      resolveBacklogPath(session),
      resolve(dataDir, "sprints", "01SPRINTTEST001ULID00000000", "backlog.json"),
    );
  });
```

- [ ] **Step 6.2 — Lancer le test pour vérifier l'échec**

```bash
npx tsx --test src/orchestrator/backlog-io.test.ts
```

Résultat attendu : le nouveau test échoue (`resolveBacklogPath` ne connaît pas encore `activeSprintId`).

- [ ] **Step 6.3 — Modifier `resolveBacklogPath` dans `backlog-io.ts`**

Remplacer la fonction `resolveBacklogPath` existante par :

```typescript
export function resolveBacklogPath(session: OrchestratorSession): string {
  const dataDir = session.activeProject?.projectDataDir;
  if (session.activeSprintId && dataDir) {
    return resolve(dataDir, "sprints", session.activeSprintId, "backlog.json");
  }
  if (session.activeProjectSlug) return resolve(resolveLastRunDir(session), "backlog.json");
  return BACKLOG_FALLBACK_PATH;
}
```

- [ ] **Step 6.4 — Relancer les tests backlog-io**

```bash
npx tsx --test src/orchestrator/backlog-io.test.ts
```

Résultat attendu : tous les tests passent (nouveaux + existants).

- [ ] **Step 6.5 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 6.6 — Lancer la suite complète**

```bash
npm test
```

Résultat attendu : tous les tests passent.

- [ ] **Step 6.7 — Commit**

```bash
git add src/orchestrator/backlog-io.ts src/orchestrator/backlog-io.test.ts
git commit -m "feat: resolveBacklogPath route vers sprints/<id>/backlog.json si activeSprintId"
```

---

## Task 7 — Wirer les sprints dans `pipeline-backlog.ts` et `cli.ts`

**Files:**
- Modify: `src/orchestrator/pipeline-backlog.ts`
- Modify: `src/orchestrator/cli.ts`
- Modify: `src/orchestrator/cli-pipeline.test.ts`

- [ ] **Step 7.1 — Modifier `pipelineBacklogReflection` pour créer un sprint**

Dans `src/orchestrator/pipeline-backlog.ts`, ajouter l'import :

```typescript
import { createSprint, loadSprintIndex, updateSprintIssueCount } from "./sprint-io.js";
```

Au début de `pipelineBacklogReflection`, juste après les logs de console et avant la déclaration de `frugal`, ajouter :

```typescript
  // Créer un sprint si projectDataDir est disponible
  if (session.activeProject?.projectDataDir) {
    const sprintId = createSprint(session.activeProject.projectDataDir, direction, brief);
    session.activeSprintId = sprintId;
    session.agentOutputRelativeSubdir = `sprints/${sprintId}`;
    console.log(`   📁 Sprint : ${sprintId}`);
  }
```

Après `saveBacklog(session, backlog)` (à la fin de la fonction), ajouter le comptage :

```typescript
  if (session.activeProject?.projectDataDir && session.activeSprintId) {
    updateSprintIssueCount(session.activeProject.projectDataDir, session.activeSprintId, parsedIssues.length);
  }
```

- [ ] **Step 7.2 — Ajouter la migration dans `cli.ts` après chargement du projet**

Dans `src/orchestrator/cli.ts`, ajouter l'import :

```typescript
import { loadSprintIndex, migrateLegacyBacklogToSprint } from "./sprint-io.js";
```

Après le bloc `if (projectFlag !== -1)` qui se termine par `warnIfLegacyLastRunDataExists(...)`, ajouter :

```typescript
  // Migration automatique backlog.json → sprints/ si nécessaire
  if (session.activeProject?.projectDataDir) {
    migrateLegacyBacklogToSprint(session.activeProject.projectDataDir);
  }
```

- [ ] **Step 7.3 — Ajouter l'option `--sprint` dans `cli.ts`**

Après le bloc `--backlog-id` (ligne ~73), ajouter :

```typescript
  const sprintFlag = args.indexOf("--sprint");
  if (sprintFlag !== -1) {
    const sprintId = args[sprintFlag + 1]?.trim();
    if (!sprintId || sprintId.startsWith("--")) {
      console.error("❌ --sprint nécessite un ULID de sprint (26 caractères).");
      process.exit(1);
    }
    session.activeSprintId = sprintId;
  }
```

- [ ] **Step 7.4 — Résoudre `activeSprint` pour `pipeline next` si pas de `--sprint`**

Dans le bloc `if (subcommand === "next")` de `cli.ts`, ajouter avant l'appel `pipelineNext` :

```typescript
      // Charger le sprint actif si --sprint non passé explicitement
      if (!session.activeSprintId && session.activeProject?.projectDataDir) {
        const index = loadSprintIndex(session.activeProject.projectDataDir);
        if (index?.activeSprint) {
          session.activeSprintId = index.activeSprint;
        }
      }
```

- [ ] **Step 7.5 — Améliorer l'affichage `--backlog` avec la liste des sprints**

Dans le bloc `} else if (backlogFlag !== -1) {` de `cli.ts`, remplacer :

```typescript
  } else if (backlogFlag !== -1) {
    printBacklogSummary(session);
```

Par :

```typescript
  } else if (backlogFlag !== -1) {
    const dataDir = session.activeProject?.projectDataDir;
    if (dataDir) {
      const index = loadSprintIndex(dataDir);
      if (index && index.sprints.length > 0) {
        console.log("\n" + "═".repeat(60));
        console.log("🗂️  SPRINTS");
        console.log("═".repeat(60));
        for (const s of [...index.sprints].reverse()) {
          const active = s.id === index.activeSprint ? " ← actif" : "";
          const date = new Date(s.createdAt).toLocaleString("fr-FR");
          console.log(`  ${s.id}${active}`);
          console.log(`    ${date} [${s.direction}] ${s.issueCount} issue(s) — ${s.brief}`);
        }
        console.log("═".repeat(60));
        // Charger le backlog du sprint actif
        session.activeSprintId = index.activeSprint;
      }
    }
    printBacklogSummary(session);
```

- [ ] **Step 7.6 — Écrire un test pour l'option `--sprint`**

Dans `src/orchestrator/cli-pipeline.test.ts`, ajouter :

```typescript
describe("--sprint option parsing", () => {
  it("rejette --sprint sans valeur via le binaire CLI", () => {
    const entry = resolve(process.cwd(), "src/orchestrator.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--sprint"],
      {
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "test-cli-key" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /--sprint nécessite un ULID/);
  });
});
```

- [ ] **Step 7.7 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 7.8 — Lancer la suite complète**

```bash
npm test
```

Résultat attendu : tous les tests passent.

- [ ] **Step 7.9 — Commit**

```bash
git add src/orchestrator/pipeline-backlog.ts src/orchestrator/cli.ts src/orchestrator/cli-pipeline.test.ts
git commit -m "feat: sprints wired — pipeline backlog crée un sprint, pipeline next charge le sprint actif"
```

---

## Vérification finale

- [ ] **Vérification de type complète**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Suite de tests complète**

```bash
npm test
```

Résultat attendu : tous les tests passent.

- [ ] **Vérification des prompts**

```bash
npm run verify:prompts
```

Résultat attendu : tous les fichiers prompts présents.

- [ ] **Commit de clôture si rien de non commité**

```bash
git status
```

Tout doit être commité. Si des fichiers sont en attente, les ajouter et commiter.
