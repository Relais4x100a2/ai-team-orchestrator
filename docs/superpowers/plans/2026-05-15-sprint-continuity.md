# Sprint Continuity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject the active sprint's backlog into the PM context when starting a new `pipeline backlog forward/backward` run, so the PM revises rather than restarts from zero.

**Architecture:** Four surgical changes — a new `formatBacklogForContext` pure function in `backlog-io.ts`, a `parentSprintId` field in `SprintEntry`, a `fromSprintId` parameter wired through `pipelineBacklogReflection`, and a `--from-sprint` CLI option that defaults to the active sprint.

**Tech Stack:** TypeScript, Node.js, `node:test` + `node:assert/strict`, `tsx --test`

---

## File Map

| File | Change |
|---|---|
| `src/orchestrator/backlog-io.ts` | Add `formatBacklogForContext` + `BACKLOG_CONTEXT_MAX_CHARS` constant |
| `src/orchestrator/backlog-io.test.ts` | Add 3 tests for `formatBacklogForContext` |
| `src/orchestrator/sprint-io.ts` | Add `parentSprintId?: string` to `SprintEntry`; add optional param to `createSprint` |
| `src/orchestrator/sprint-io.test.ts` | Add 2 tests for `parentSprintId` in `createSprint` |
| `src/orchestrator/pipeline-backlog.ts` | Add `fromSprintId?: string` param; load source backlog; update `withSnapshot`; pass `fromSprintId` to `createSprint` |
| `src/orchestrator/cli.ts` | Add `--from-sprint` parsing; resolve default in `backlog` subcommand; update `--backlog` display |
| `src/orchestrator/cli-pipeline.test.ts` | Add 2 tests for `--from-sprint` validation |

---

## Task 1 — `formatBacklogForContext` dans `backlog-io.ts`

**Files:**
- Modify: `src/orchestrator/backlog-io.ts`
- Modify: `src/orchestrator/backlog-io.test.ts`

- [ ] **Step 1.1 — Écrire les tests (rouge)**

Dans `src/orchestrator/backlog-io.test.ts`, ajouter en tête des imports :

```typescript
import type { Backlog, BacklogIssue } from "../backlog.js";
import { formatBacklogForContext, loadBacklog, resolveBacklogPath } from "./backlog-io.js";
```

Remplacer la ligne existante :
```typescript
import { loadBacklog, resolveBacklogPath } from "./backlog-io.js";
```

Puis ajouter à la fin du fichier :

```typescript
describe("formatBacklogForContext", () => {
  const base: Omit<BacklogIssue, "id" | "status"> = {
    title: "Feature A",
    description: "Description de l'issue A.",
    priority: "MUST",
    size: "M",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    pipelineRun: null,
  };

  it("retourne une chaîne vide si aucune issue ouverte (done/skipped uniquement)", () => {
    const b: Backlog = {
      version: 2,
      lastUpdated: "",
      backlogDocumentId: "01TEST00000000000000000000",
      issues: [
        { ...base, id: "BP-001", status: "done" },
        { ...base, id: "BP-002", status: "skipped" },
      ],
    };
    assert.equal(formatBacklogForContext(b), "");
  });

  it("inclut les issues todo et in_progress, exclut done et skipped", () => {
    const b: Backlog = {
      version: 2,
      lastUpdated: "",
      backlogDocumentId: "01TEST00000000000000000000",
      issues: [
        { ...base, id: "BP-001", status: "todo" },
        { ...base, id: "BP-002", status: "in_progress" },
        { ...base, id: "BP-003", status: "done" },
        { ...base, id: "BP-004", status: "skipped" },
      ],
    };
    const result = formatBacklogForContext(b);
    assert.ok(result.includes("BP-001"), "doit contenir BP-001 (todo)");
    assert.ok(result.includes("BP-002"), "doit contenir BP-002 (in_progress)");
    assert.ok(!result.includes("BP-003"), "ne doit pas contenir BP-003 (done)");
    assert.ok(!result.includes("BP-004"), "ne doit pas contenir BP-004 (skipped)");
    assert.ok(result.includes("## Backlog existant (2 issue(s) ouvertes)"));
  });

  it("tronque à 3 000 caractères max avec marqueur [tronqué]", () => {
    const longDesc = "y".repeat(500);
    const issues: BacklogIssue[] = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      id: `BP-${String(i + 1).padStart(3, "0")}`,
      status: "todo" as const,
      description: longDesc,
    }));
    const b: Backlog = {
      version: 2,
      lastUpdated: "",
      backlogDocumentId: "01TEST00000000000000000000",
      issues,
    };
    const result = formatBacklogForContext(b);
    assert.ok(result.length <= 3100, `longueur ${result.length} > 3100`);
    assert.ok(result.includes("[…tronqué]"), "doit contenir le marqueur de troncature");
  });
});
```

- [ ] **Step 1.2 — Vérifier que les tests échouent**

```bash
npm test 2>&1 | grep -E "(FAIL|formatBacklogForContext|not exported)"
```

Résultat attendu : erreur du type `formatBacklogForContext is not a function` ou `not exported`.

- [ ] **Step 1.3 — Implémenter `formatBacklogForContext` dans `backlog-io.ts`**

Ajouter à la fin de `src/orchestrator/backlog-io.ts` :

```typescript
const BACKLOG_CONTEXT_MAX_CHARS = 3000;

export function formatBacklogForContext(backlog: Backlog): string {
  const openIssues = backlog.issues.filter(
    (i) => i.status === "todo" || i.status === "in_progress",
  );
  if (openIssues.length === 0) return "";

  const header = `## Backlog existant (${openIssues.length} issue(s) ouvertes)`;
  const parts = openIssues.map((i) => {
    const desc = i.description.slice(0, 200);
    const suffix = i.description.length > 200 ? "…" : "";
    return `### ${i.id} [${i.priority} / ${i.size}] — ${i.title}\n${i.status} | ${desc}${suffix}`;
  });

  const full = `${header}\n\n${parts.join("\n\n")}`;
  if (full.length <= BACKLOG_CONTEXT_MAX_CHARS) return full;
  return full.slice(0, BACKLOG_CONTEXT_MAX_CHARS) + "\n\n[…tronqué]";
}
```

- [ ] **Step 1.4 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 1.5 — Vérifier que les tests passent**

```bash
npm test 2>&1 | grep -E "(pass|fail|formatBacklogForContext)"
```

Résultat attendu : 3 tests supplémentaires passants, 0 échec.

- [ ] **Step 1.6 — Commit**

```bash
git add src/orchestrator/backlog-io.ts src/orchestrator/backlog-io.test.ts
git commit -m "feat: formatBacklogForContext — sérialise les issues ouvertes pour contexte PM"
```

---

## Task 2 — `parentSprintId` dans `sprint-io.ts`

**Files:**
- Modify: `src/orchestrator/sprint-io.ts`
- Modify: `src/orchestrator/sprint-io.test.ts`

- [ ] **Step 2.1 — Écrire les tests (rouge)**

Dans `src/orchestrator/sprint-io.test.ts`, ajouter dans le `describe("createSprint")` existant (après les deux tests existants) :

```typescript
  it("persiste parentSprintId dans index.json quand fourni", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    const parentId = createSprint(tmp, "forward", "Sprint parent");
    const childId = createSprint(tmp, "backward", "Sprint enfant", parentId);
    const index = loadSprintIndex(tmp);
    const child = index!.sprints.find((s) => s.id === childId);
    assert.equal(child!.parentSprintId, parentId);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("laisse parentSprintId absent si non fourni", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    const id = createSprint(tmp, "forward", "Sprint sans parent");
    const index = loadSprintIndex(tmp);
    const entry = index!.sprints.find((s) => s.id === id);
    assert.equal(entry!.parentSprintId, undefined);
    rmSync(tmp, { recursive: true, force: true });
  });
```

- [ ] **Step 2.2 — Vérifier que les tests échouent**

```bash
npm test 2>&1 | grep -E "(FAIL|parentSprintId)"
```

Résultat attendu : les 2 nouveaux tests échouent (`parentSprintId` non défini dans le type ou non transmis).

- [ ] **Step 2.3 — Mettre à jour `SprintEntry` et `createSprint` dans `sprint-io.ts`**

Remplacer le type `SprintEntry` :

```typescript
export type SprintEntry = {
  id: string;
  createdAt: string;
  direction: "forward" | "backward";
  brief: string;
  issueCount: number;
  parentSprintId?: string;
};
```

Remplacer la fonction `createSprint` entière :

```typescript
export function createSprint(
  projectDataDir: string,
  direction: "forward" | "backward",
  brief: string,
  parentSprintId?: string,
): string {
  const id = ulid();
  mkdirSync(resolve(resolveSprintsDir(projectDataDir), id), { recursive: true });
  const existing = loadSprintIndex(projectDataDir);
  const truncatedBrief = brief.slice(0, 200);
  if (truncatedBrief.length < brief.length) {
    console.warn(`   ⚠️  Brief tronqué à 200 caractères (${brief.length} → 200).`);
  }
  const entry: SprintEntry = {
    id,
    createdAt: new Date().toISOString(),
    direction,
    brief: truncatedBrief,
    issueCount: 0,
    ...(parentSprintId ? { parentSprintId } : {}),
  };
  saveSprintIndex(projectDataDir, {
    activeSprint: id,
    sprints: [...(existing?.sprints ?? []), entry],
  });
  return id;
}
```

- [ ] **Step 2.4 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 2.5 — Vérifier que les tests passent**

```bash
npm test 2>&1 | tail -10
```

Résultat attendu : tous les tests passent, 0 échec.

- [ ] **Step 2.6 — Commit**

```bash
git add src/orchestrator/sprint-io.ts src/orchestrator/sprint-io.test.ts
git commit -m "feat: SprintEntry.parentSprintId — traçabilité lignée entre sprints"
```

---

## Task 3 — Wirer dans `pipeline-backlog.ts`

**Files:**
- Modify: `src/orchestrator/pipeline-backlog.ts`

Pas de nouveaux tests unitaires pour `pipelineBacklogReflection` (appelle des agents externes). La couverture vient des tests d'intégration CLI existants + vérification tsc.

- [ ] **Step 3.1 — Mettre à jour les imports dans `pipeline-backlog.ts`**

Remplacer :
```typescript
import { writeFileSync } from "fs";
import { resolve } from "path";
import type { IssueSize } from "../backlog.js";
import { generateIssueId, parsePMOutput } from "../backlog.js";
```

Par :
```typescript
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { Backlog, IssueSize } from "../backlog.js";
import { generateIssueId, parsePMOutput } from "../backlog.js";
```

Et remplacer :
```typescript
import { loadBacklog, saveBacklog, printBacklogSummary } from "./backlog-io.js";
```

Par :
```typescript
import { formatBacklogForContext, loadBacklog, saveBacklog, printBacklogSummary } from "./backlog-io.js";
```

- [ ] **Step 3.2 — Mettre à jour la signature de `pipelineBacklogReflection`**

Remplacer :
```typescript
export async function pipelineBacklogReflection(
  session: OrchestratorSession,
  direction: "forward" | "backward",
  brief: string,
): Promise<void> {
```

Par :
```typescript
export async function pipelineBacklogReflection(
  session: OrchestratorSession,
  direction: "forward" | "backward",
  brief: string,
  fromSprintId?: string,
): Promise<void> {
```

- [ ] **Step 3.3 — Charger le backlog source et mettre à jour `withSnapshot`**

Dans `pipelineBacklogReflection`, ajouter juste après le bloc `console.log` initial (avant `if (session.activeProject?.projectDataDir)`) :

```typescript
  let backlogContext = "";
  if (fromSprintId && session.activeProject?.projectDataDir) {
    const sourcePath = resolve(
      session.activeProject.projectDataDir,
      "sprints",
      fromSprintId,
      "backlog.json",
    );
    if (existsSync(sourcePath)) {
      try {
        const sourceBacklog = JSON.parse(readFileSync(sourcePath, "utf-8")) as Backlog;
        backlogContext = formatBacklogForContext(sourceBacklog);
        console.log(`   🔗 Continuité depuis sprint : ${fromSprintId}`);
      } catch {
        console.warn(`   ⚠️  Sprint source : lecture échouée — démarrage sans contexte.`);
      }
    } else {
      console.warn(`   ⚠️  Sprint source introuvable : ${fromSprintId} — démarrage sans contexte.`);
    }
  }
```

Puis remplacer la fonction `withSnapshot` existante :

```typescript
  const withSnapshot = (ctx: string): string =>
    codeSnapshot ? `## Contexte code du projet\n\n${codeSnapshot}\n\n---\n\n${ctx}` : ctx;
```

Par :

```typescript
  const withSnapshot = (ctx: string): string => {
    const parts: string[] = [];
    if (backlogContext) parts.push(backlogContext);
    if (codeSnapshot) parts.push(`## Contexte code du projet\n\n${codeSnapshot}`);
    parts.push(ctx);
    return parts.join("\n\n---\n\n");
  };
```

- [ ] **Step 3.4 — Passer `fromSprintId` à `createSprint`**

Remplacer dans le bloc sprint creation :

```typescript
    const sprintId = createSprint(session.activeProject.projectDataDir, direction, brief);
```

Par :

```typescript
    const sprintId = createSprint(session.activeProject.projectDataDir, direction, brief, fromSprintId);
```

- [ ] **Step 3.5 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 3.6 — Vérifier que tous les tests passent**

```bash
npm test 2>&1 | tail -10
```

Résultat attendu : tous les tests passent, 0 échec.

- [ ] **Step 3.7 — Commit**

```bash
git add src/orchestrator/pipeline-backlog.ts
git commit -m "feat: pipeline backlog injecte le backlog du sprint source dans le contexte PM"
```

---

## Task 4 — CLI `--from-sprint` + affichage parent

**Files:**
- Modify: `src/orchestrator/cli.ts`
- Modify: `src/orchestrator/cli-pipeline.test.ts`

- [ ] **Step 4.1 — Écrire les tests CLI (rouge)**

Dans `src/orchestrator/cli-pipeline.test.ts`, ajouter un nouveau `describe` à la fin :

```typescript
describe("--from-sprint option parsing", () => {
  it("rejette --from-sprint sans valeur via le binaire CLI", () => {
    const entry = resolve(process.cwd(), "src/orchestrator.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--from-sprint"],
      {
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "test-cli-key" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /--from-sprint nécessite un ULID/);
  });

  it("rejette --from-sprint avec un format non-ULID via le binaire CLI", () => {
    const entry = resolve(process.cwd(), "src/orchestrator.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--from-sprint", "pas-un-ulid"],
      {
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY ?? "test-cli-key" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /format ULID invalide/);
  });
});
```

- [ ] **Step 4.2 — Vérifier que les tests échouent**

```bash
npm test 2>&1 | grep -E "(FAIL|from-sprint)"
```

Résultat attendu : les 2 tests `--from-sprint` échouent (option inconnue, pas d'exit 1 attendu).

- [ ] **Step 4.3 — Ajouter le parsing `--from-sprint` dans `cli.ts`**

Après le bloc `--sprint` (qui se termine par `session.activeSprintId = sprintId;`), ajouter :

```typescript
  const fromSprintFlag = args.indexOf("--from-sprint");
  let cliFromSprintId: string | undefined;
  if (fromSprintFlag !== -1) {
    const val = args[fromSprintFlag + 1]?.trim();
    if (!val || val.startsWith("--")) {
      console.error("❌ --from-sprint nécessite un ULID de sprint (26 caractères).");
      process.exit(1);
    }
    if (!isValidBacklogDocumentId(val)) {
      console.error("❌ --from-sprint : format ULID invalide (Crockford base32, 26 caractères).");
      process.exit(1);
    }
    if (session.activeProject?.projectDataDir) {
      const idx = loadSprintIndex(session.activeProject.projectDataDir);
      if (!idx?.sprints.find((s) => s.id === val)) {
        console.error(`❌ --from-sprint : sprint « ${val} » introuvable dans sprints/index.json.`);
        process.exit(1);
      }
    }
    cliFromSprintId = val;
  }
```

- [ ] **Step 4.4 — Résoudre le sprint source par défaut et passer à `pipelineBacklogReflection`**

Dans le bloc `} else if (subcommand === "backlog") {`, remplacer :

```typescript
      const briefFromCli = args.slice(pipelineFlag + 3).join(" ");
      const brief = briefFromFile ?? (briefFromCli || "Structurer ou réviser le backlog selon le contexte fourni.");
      await pipelineBacklogReflection(session, direction, brief);
```

Par :

```typescript
      const briefFromCli = args.slice(pipelineFlag + 3).join(" ");
      const brief = briefFromFile ?? (briefFromCli || "Structurer ou réviser le backlog selon le contexte fourni.");
      // Résoudre le sprint source : --from-sprint explicite, sinon sprint actif
      let fromSprintId = cliFromSprintId;
      if (!fromSprintId && session.activeProject?.projectDataDir) {
        const index = loadSprintIndex(session.activeProject.projectDataDir);
        if (index?.activeSprint) {
          fromSprintId = index.activeSprint;
        }
      }
      await pipelineBacklogReflection(session, direction, brief, fromSprintId);
```

- [ ] **Step 4.5 — Afficher le parent dans `--backlog`**

Dans le bloc `--backlog` (boucle `for (const s of [...index.sprints].reverse())`), remplacer :

```typescript
          console.log(`  ${s.id}${active}`);
          console.log(`    ${date} [${s.direction}] ${s.issueCount} issue(s) — ${s.brief}`);
```

Par :

```typescript
          console.log(`  ${s.id}${active}`);
          console.log(`    ${date} [${s.direction}] ${s.issueCount} issue(s) — ${s.brief}`);
          if (s.parentSprintId) {
            console.log(`    └─ parent : ${s.parentSprintId}`);
          }
```

- [ ] **Step 4.6 — Vérifier les types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Step 4.7 — Vérifier que tous les tests passent**

```bash
npm test 2>&1 | tail -10
```

Résultat attendu : tous les tests passent, 0 échec.

- [ ] **Step 4.8 — Commit**

```bash
git add src/orchestrator/cli.ts src/orchestrator/cli-pipeline.test.ts
git commit -m "feat: --from-sprint — continuité inter-sprints via injection backlog source"
```

---

## Vérification finale

- [ ] **Types**

```bash
npx tsc --noEmit
```

Résultat attendu : aucune erreur.

- [ ] **Suite complète**

```bash
npm test 2>&1 | tail -10
```

Résultat attendu : tous les tests passent.

- [ ] **Vérification prompts**

```bash
npm run verify:prompts
```

Résultat attendu : tous les fichiers prompts présents.

- [ ] **Git status propre**

```bash
git status
```

Résultat attendu : rien à commiter.
