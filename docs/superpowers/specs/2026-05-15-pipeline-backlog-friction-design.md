# Design : Amélioration pipeline backlog — 4 points de friction

**Date** : 2026-05-15  
**Scope** : `pipeline backlog forward/backward` uniquement (pas de changement au flux `pipeline next`)  
**Approche retenue** : Option A — changements chirurgicaux indépendants

---

## Contexte

Quatre frictions identifiées sur un run `pipeline backlog forward` réel :

1. Les questions ouvertes émises par un agent ne sont ni transmises ni répondues.
2. L'agent red team opère sans lire le code, ce qui génère des incertitudes explicites dans sa sortie.
3. Plus généralement, pm/architect/redteam n'ont pas d'instruction explicite pour explorer le code existant.
4. Un seul `backlog.json` par projet : les runs successifs s'accumulent dans le même fichier sans distinction.

---

## Point 1 — Questions ouvertes : pause interactive

### Comportement cible

Quand un agent émet une question ouverte dans sa sortie, le pipeline s'arrête, affiche la question, attend une réponse utilisateur (stdin), puis injecte la réponse dans `additionalContext` de l'agent suivant.

En mode non-interactif (pas de TTY, ex. CI), les questions sont loguées comme avertissements et le pipeline continue sans pause.

### Fichiers nouveaux

**`src/orchestrator/open-questions.ts`**

- `extractOpenQuestions(text: string): string[]`  
  Détecte les questions dans la sortie agent. Cherche en priorité une section `### Question ouverte` (pattern observé dans les sorties PM). Fallback : tout paragraphe de fin se terminant par `?`. Retourne un tableau de chaînes (une par question distincte).

- `promptOpenQuestions(questions: string[]): Promise<string>`  
  Affiche chaque question numérotée sur `stdout`, lit la réponse via `readline` sur `stdin`. Retourne une chaîne prête à injecter :
  ```
  ## Réponses aux questions ouvertes
  1. [question] → [réponse utilisateur]
  ```

### Modification de `pipeline-backlog.ts`

Dans `pipelineBacklogReflection`, après chaque `runAgent` (PM initial, architect, redteam) :

```typescript
const questions = extractOpenQuestions(agentOutput);
if (questions.length > 0 && process.stdin.isTTY) {
  const answers = await promptOpenQuestions(questions);
  // answers injectées dans additionalContext de l'agent suivant
}
```

Les réponses sont préfixées avant le contexte existant de l'agent suivant (pas de modification du contexte des agents antérieurs).

### Ce qui ne change pas

Format de sortie des agents, prompts, logique `parsePMOutput`, flux PM→architect→redteam→PM.

---

## Point 2 & 3 — Accès au code (instruction + injection sélective)

### Comportement cible

- Les prompts des agents backlog (PM, architect, red team) instruisent explicitement d'explorer le code avant de répondre.
- L'orchestrateur injecte un snapshot léger du code dans `additionalContext` — uniquement quand `local_path` est défini.

### Modifications des prompts

Ajout d'un paragraphe de règle dans `src/prompts/product-manager.md`, `src/prompts/data-architect.md`, `src/prompts/red-team-reflection.md` :

> **Règle code existant** : si le projet dispose d'un chemin local (`local_path`), explore la structure du code (fichiers récemment modifiés, arbre de répertoires, README) **avant** de produire ta réponse. Tes conclusions doivent refléter la réalité du dépôt, pas seulement le brief fourni.

### Fichier nouveau

**`src/orchestrator/code-snapshot.ts`**

- `buildCodeSnapshot(localPath: string, projectDataDir?: string): string`  
  Retourne un bloc markdown capé à ~2 000 caractères :
  1. **Priorité** : si `context.md` existe dans `projectDataDir` → l'utiliser (produit par `npm run context:scan`).
  2. **Fallback** : `git log --oneline -7` + `git diff --stat HEAD~3` + arbre `find . -maxdepth 2` (exclusions : `node_modules`, `.git`, `dist`).

### Modification de `pipeline-backlog.ts`

Au début de `pipelineBacklogReflection`, si `session.activeProject?.localPath` est défini :

```typescript
const codeSnapshot = buildCodeSnapshot(
  session.activeProject.localPath,
  session.activeProject.projectDataDir,
);
// Préfixé dans additionalContext de chaque runAgent (pm, architect, redteam, pm-synthèse)
```

Zéro impact sur les runs sans `local_path` (mode cloud pur).

### Ce qui ne change pas

`runAgent`, `agent-runner.ts`, résolution de modèle, mode cloud/local.

---

## Point 4 — Backlogs multi-run : dossier `sprints/` avec index

### Structure sur disque

```
<projectDataDir>/
  sprints/
    index.json               ← liste des runs, sprint actif
    <ULID-sprint>/           ← créé par chaque pipeline forward/backward
      backlog.json
      pm.md
      architect.md
      redteam_reflection.md
  run-context.json           ← inchangé
  runs/                      ← inchangé (artefacts pipeline next)
```

### `sprints/index.json`

```json
{
  "activeSprint": "01KRN...",
  "sprints": [
    {
      "id": "01KRN...",
      "createdAt": "2026-05-15T07:00:00Z",
      "direction": "forward",
      "brief": "Créé le backlog des améliorations de prompt",
      "issueCount": 4
    }
  ]
}
```

### Modifications de `OrchestratorSession`

Ajout d'un champ optionnel dans `session.ts` :

```typescript
activeSprintId: string | null;
```

### Modifications de `pipeline-backlog.ts`

Au début de `pipelineBacklogReflection` :
1. Générer un ULID → `sprintId`.
2. Créer `sprints/<sprintId>/` dans `projectDataDir`.
3. Mettre à jour `session.activeSprintId = sprintId`.
4. Mettre à jour `session.agentOutputRelativeSubdir = sprints/${sprintId}` → redirige automatiquement la sauvegarde des `pm.md` / `architect.md` / `redteam_reflection.md` via le mécanisme existant de `agent-runner.ts`.
5. Mettre à jour `sprints/index.json` (créer si absent, ajouter l'entrée, définir `activeSprint`).

### Modifications de `backlog-io.ts`

`resolveBacklogPath` : priorité à `sprints/<activeSprintId>/backlog.json` quand `session.activeSprintId` est défini.

### Modifications de `cli.ts`

- Nouvelle option `--sprint <ULID>` : charge un sprint précis (définit `session.activeSprintId` avant `pipelineNext`).
- Sans `--sprint` : `pipelineNext` lit `activeSprint` depuis `sprints/index.json`.

### Migration automatique

Au premier run avec la nouvelle version, si `backlog.json` existe à la racine de `projectDataDir` et que `sprints/` est absent :
- Déplacer `backlog.json` → `sprints/<ULID-migré>/backlog.json`.
- Créer `sprints/index.json` avec ce sprint comme `activeSprint`.
- Logger l'opération.

La migration vit dans `backlog-io.ts` et est appelée depuis `resolveBacklogPath`.

### Commande `npm run backlog`

Affiche la liste des sprints (id, date, brief, nb issues) avec le sprint actif marqué. Réutilise `printBacklogSummary` sur le sprint actif.

### Ce qui ne change pas

Flux `pipeline next`, `runs/`, `run-context.json`, `--backlog-id`, `--sync-issues`, `pipeline-execution-run.ts`.

---

## Récapitulatif des fichiers touchés

| Fichier | Type de changement |
|---|---|
| `src/orchestrator/open-questions.ts` | **Nouveau** |
| `src/orchestrator/code-snapshot.ts` | **Nouveau** |
| `src/orchestrator/pipeline-backlog.ts` | Modification (insertion des 3 mécanismes) |
| `src/orchestrator/backlog-io.ts` | Modification (`resolveBacklogPath` + migration) |
| `src/orchestrator/session.ts` | Modification (champ `activeSprintId`) |
| `src/orchestrator/cli.ts` | Modification (option `--sprint`, commande `backlog`) |
| `src/prompts/product-manager.md` | Modification (règle code existant) |
| `src/prompts/data-architect.md` | Modification (règle code existant) |
| `src/prompts/red-team-reflection.md` | Modification (règle code existant) |

## Hors scope

- CI GitHub Actions, tests automatisés des contraintes de prompt.
- Modification du flux `pipeline next` (architect → dev ⇄ security ⇄ QA).
- Interface graphique ou dashboard des sprints.
- Export / archivage automatique des sprints terminés.
