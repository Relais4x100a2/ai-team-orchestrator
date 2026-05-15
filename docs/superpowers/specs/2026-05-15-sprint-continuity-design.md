# Design : Continuité inter-sprints (inject-only)

**Date** : 2026-05-15  
**Scope** : `pipeline backlog forward/backward` uniquement  
**Approche retenue** : Injection du backlog source dans le contexte PM (Approche B)

---

## Contexte

Chaque `pipeline backlog forward/backward` crée un sprint avec un backlog vide. Les issues non traitées du sprint précédent disparaissent de `pipeline next`, et le PM repart de zéro sans connaître l'existant.

**Objectif** : le nouveau sprint part du backlog actif comme base de révision, et les items non traités sont automatiquement disponibles.

---

## Architecture

Un seul paramètre traverse tout le flux : `fromSprintId?: string`.

```
cli.ts
  ↓ résout --from-sprint (explicite) ou activeSprint (défaut index.json)
  ↓ passe fromSprintId à pipelineBacklogReflection
pipeline-backlog.ts
  ↓ charge sprints/<fromSprintId>/backlog.json
  ↓ formate en markdown → injecté en tête du contexte PM
  ↓ passe parentSprintId à createSprint pour traçabilité
sprint-io.ts — SprintEntry.parentSprintId?: string
backlog-io.ts — formatBacklogForContext(backlog): string (nouvelle fonction)
```

Aucun impact sur `pipeline next`, `runs/`, `run-context.json`, ni sur le format de `backlog.json`.

---

## Section 1 — CLI (`src/orchestrator/cli.ts`)

### Nouvelle option `--from-sprint <ULID>`

Parsée après `--sprint`. Même validation que `--sprint` :
- Format ULID via `isValidBacklogDocumentId`
- Existence dans `sprints/index.json` si `projectDataDir` disponible

**Résolution par défaut** : si `--from-sprint` est absent et qu'un `activeSprint` existe dans `index.json`, il devient le sprint source. Si aucun sprint n'existe encore, `fromSprintId` reste `undefined` → comportement inchangé (démarrage vide).

**Signature mise à jour** :
```typescript
await pipelineBacklogReflection(session, direction, brief, fromSprintId);
```

**Log console** si un sprint source est résolu :
```
   🔗 Continuité depuis sprint : 01KRNABC...
```

---

## Section 2 — Modèle de données (`src/orchestrator/sprint-io.ts`)

### `SprintEntry` — champ ajouté

```typescript
export type SprintEntry = {
  id: string;
  createdAt: string;
  direction: "forward" | "backward";
  brief: string;
  issueCount: number;
  parentSprintId?: string;  // traçabilité de la lignée
};
```

### `createSprint` — paramètre optionnel

```typescript
export function createSprint(
  projectDataDir: string,
  direction: "forward" | "backward",
  brief: string,
  parentSprintId?: string,
): string
```

Pas de migration nécessaire : le champ est optionnel, les entrées existantes restent valides.

### Affichage `--backlog` (si `parentSprintId` présent)

```
  01KRNB... ← actif
    2026-05-16 [forward] 8 issue(s) — Feedback sprint 2
    └─ parent : 01KRNA...
```

---

## Section 3 — Formatage du backlog source (`src/orchestrator/backlog-io.ts`)

### Nouvelle fonction `formatBacklogForContext`

```typescript
export function formatBacklogForContext(backlog: Backlog): string
```

Sérialise les issues en markdown compact, cap à 3 000 caractères (marqueur `[…tronqué]`).

**Issues incluses** : `todo` et `in_progress` uniquement. Les issues `done` et `skipped` sont exclues.

**Champs inclus par issue** : `id`, `priority`, `size`, `title`, `status`, `description` (200 chars max).

**Format** :
```markdown
## Backlog existant (N issues)

### #BP-001 [MUST / M] — Titre de l'issue
todo | Description tronquée…

### #BP-002 [SHOULD / L] — Autre titre
in_progress | Description…
```

---

## Section 4 — Injection dans `pipelineBacklogReflection` (`src/orchestrator/pipeline-backlog.ts`)

### Signature mise à jour

```typescript
export async function pipelineBacklogReflection(
  session: OrchestratorSession,
  direction: "forward" | "backward",
  brief: string,
  fromSprintId?: string,
): Promise<void>
```

### Logique d'injection

Au début de la fonction, si `fromSprintId` est défini et que `projectDataDir` est disponible :

```typescript
let backlogContext = "";
if (fromSprintId && session.activeProject?.projectDataDir) {
  const sourcePath = resolve(
    session.activeProject.projectDataDir,
    "sprints", fromSprintId, "backlog.json",
  );
  if (existsSync(sourcePath)) {
    const sourceBacklog = JSON.parse(readFileSync(sourcePath, "utf-8")) as Backlog;
    backlogContext = formatBacklogForContext(sourceBacklog);
    console.log(`   🔗 Continuité depuis sprint : ${fromSprintId}`);
  } else {
    console.warn(`   ⚠️  Sprint source introuvable : ${fromSprintId} — démarrage sans contexte.`);
  }
}
```

### Ordre de priorité dans le contexte PM

`withSnapshot()` est mis à jour pour accepter un `backlogContext` optionnel :

```typescript
const withSnapshot = (ctx: string): string => {
  const parts: string[] = [];
  if (backlogContext) parts.push(backlogContext);
  if (codeSnapshot) parts.push(`## Contexte code du projet\n\n${codeSnapshot}`);
  parts.push(ctx);
  return parts.join("\n\n---\n\n");
};
```

Ordre dans le contexte injecté au PM :
1. **Backlog existant** (priorité la plus haute — c'est la base de révision)
2. **Snapshot code** (contexte technique)
3. **Brief utilisateur** (directive du run courant)

`createSprint` reçoit `fromSprintId` comme `parentSprintId`.

---

## Récapitulatif des fichiers touchés

| Fichier | Changement |
|---|---|
| `src/orchestrator/backlog-io.ts` | Nouveau : `formatBacklogForContext` |
| `src/orchestrator/backlog-io.test.ts` | Nouveau : tests `formatBacklogForContext` |
| `src/orchestrator/sprint-io.ts` | `SprintEntry.parentSprintId?`, `createSprint` param optionnel, affichage `--backlog` |
| `src/orchestrator/sprint-io.test.ts` | Tests `parentSprintId` dans `createSprint` et affichage |
| `src/orchestrator/pipeline-backlog.ts` | Param `fromSprintId`, injection backlog source, `withSnapshot` mis à jour |
| `src/orchestrator/cli.ts` | Option `--from-sprint`, résolution défaut, transmission à `pipelineBacklogReflection` |
| `src/orchestrator/cli-pipeline.test.ts` | Test `--from-sprint` validation |

## Hors scope

- UI/dashboard des lignées de sprints
- Archivage ou export automatique des sprints terminés
- Merge intelligent d'issues portant le même titre entre deux sprints
- Impact sur `pipeline next` ou les autres pipelines
