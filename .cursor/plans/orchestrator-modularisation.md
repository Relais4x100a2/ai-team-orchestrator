# Plan de modularisation — `src/orchestrator.ts`

## Objectif

Réduire la taille et les responsabilités de `orchestrator.ts` (~1500 lignes) sans changer le comportement observable du CLI ni du pipeline, en découpant par **petites PR** avec `npx tsc --noEmit` + `npm test` après chaque étape.

## Invariants (ne pas casser)

- Point d’entrée : `tsx src/orchestrator.ts` (scripts `npm` inchangés sauf si on décide d’un simple réexport — à éviter en première passe).
- Ordre du pipeline `full` et boucles Dev ⇄ Sécurité ⇄ QA inchangés.
- Persistance `last-run/<slug>/`, `run-context.json`, `backlog.json` : mêmes chemins et formats.
- Flags CLI et variables d’environnement existantes inchangés (ou documentés si ajout).

## État cible (approximatif)

- `orchestrator.ts` reste le **bootstrap** (imports minimes + `main()` ou délégation à `cli.ts`).
- Logique regroupée par **couche** dans `src/orchestrator/` (ou `src/lib/orchestrator/` si tu préfixes autrement).

## Découpage proposé (modules)

| Module | Responsabilité |
|--------|----------------|
| `orchestrator/paths-and-env.ts` | `__dirname`, `rgPath`, constantes chemins, helpers purs (`formatErrorMessage`, `previewText`, `resolveUserPath`) |
| `orchestrator/project-loader.ts` | `loadProject`, lecture frontmatter, construction `ProjectContext` |
| `orchestrator/prompts.ts` | `loadPrompt` |
| `orchestrator/run-context.ts` | `LastRunContext`, `load/saveLastRunContext`, détection URLs GitHub dans le texte, `migrateLegacySecurityFile` |
| `orchestrator/branch-guard.ts` | `enforceProjectBranchGuard`, `getProjectBranchMismatchContext`, `resyncLastRunContext…`, policy `BRANCH_MISMATCH_*` |
| `orchestrator/context-builders.ts` | `buildSecurityImplementationContext`, `buildQAPipelineContext` |
| `orchestrator/git-sync.ts` | `syncLocalGitBeforeAgent`, `runGit`, résolution mode sync / rôles |
| `orchestrator/backlog-io.ts` | `resolveBacklogPath`, `loadBacklog`, `saveBacklog`, `printBacklogSummary` (si couplage faible) |
| `orchestrator/agent-runner.ts` | `runAgent`, `requireRepoUrlForCloud` |
| `orchestrator/workflows.ts` | `fullPipeline`, `pipelineNext`, `pipelineBacklogReflection`, `pmBacklogWorkflow` |
| `orchestrator/cli.ts` | parsing argv, dispatch vers les workflows |

**Note :** `activeProject` / `activeProjectSlug` sont aujourd’hui des **globals**. 
- introduire un petit objet `OrchestratorRuntime` ou `ProjectSession` passé en paramètre aux fonctions extraites.

## Agent architect : deux situations à gérer explicitement

Le **même rôle** `architect` (même `promptFile` `data-architect`) sert aujourd’hui à deux **intentions** différentes. Sans les nommer dans le code ni relier les données, on obtient confusion produit, briefs pauvres ou sorties hors-sujet — et le mode **local** peut accentuer les échecs (`result` vide).

### Situation A — Réflexion backlog (`--pipeline backlog forward|backward`)

- **Flux :** PM → **Architect** → Red Team Réflexion ; l’architecte reçoit la sortie PM comme `additionalContext`.
- **Consigne :** vision architecture pour les **items Must/Should du backlog** (macro, cohérence globale).
- **Persistance :** un résumé tronqué (`previewText(..., 500)`) est stocké sur les issues MUST/SHOULD dans `backlog.json` (`architectureVision`, `reflectionChallenge`).

### Situation B — Exécution ticket (`pipeline next`, tailles **M / L / XL**)

- **Flux :** démarrage à l’étape `architect` (S saute l’architecte) ; `brief` = **`issue.description`** (+ lien GitHub éventuel).
- **Consigne :** **cadrage ciblé** pour sécuriser **l’exécution de ce seul backlog item**.
- **Mode :** même défaut **local** que la situation A (pas de `cloud: true`), alors que `--role architect` en solo force le **cloud**.

### Écarts constatés (à corriger ou documenter)

1. **`architectureVision` / `reflectionChallenge` du ticket ne sont pas réinjectés** dans le contexte de l’architecte en exécution (`pipeline next`). La phase backlog peut donc produire une vision stockée dans le JSON **ignorée** au run suivant.
2. **Même prompt système** pour macro (backlog) et micro (ticket) : seule la consigne utilisateur change — le modèle peut dériver si le `description` du ticket est court.
3. **Solo `--brief-file` + tâche CLI :** en mode `--role`, si `--brief-file` est présent, la **tâche devient uniquement le fichier** ; le texte après le rôle est ignoré (`briefFromFile ?? taskFromCli`). Incohérent avec `fullPipeline` où brief + tâche sont composés via `additionalContext`.
4. **Résultat vide en local** : le SDK peut renvoyer `runResult.result` falsy sans erreur ; aujourd’hui le pipeline continue avec une vision vide et `architect.md` non écrit.

### Recommandations (ordre de priorité raisonnable)

| # | Action | Détail |
|---|--------|--------|
| 1 | **Câbler le backlog vers l’exécution** | Lors de `pipelineNext` → `fullPipeline`, si `issue.architectureVision` et/ou `issue.reflectionChallenge` sont définis, les préfixer dans `additionalContext` de l’étape architecte (ou fusionner dans `brief` / `specs` avant l’appel), avec un titre Markdown clair du type « Vision déjà cadrée au backlog (résumé) » pour éviter les doublons verbeux. |
| 2 | **Renforcer la consigne situation B** | Dans `orchestrator.ts` ou dans `data-architect.md` : une phrase explicite du genre *« Tu cadres uniquement le ticket décrit ci-dessous ; si une vision backlog est fournie, tu t’y alignes et tu précises les écarts. »* (respecter la règle projet : préférer la consigne générique dans le prompt, le collage de données dans l’orchestrateur). |
| 3 | **Aligner local / cloud pour l’architecte en exécution** | Option env du type `PIPELINE_ARCHITECT_CLOUD=1` ou forcer le cloud pour l’étape architecte en `execution` si le local reste flaky ; documenter le défaut dans README/CLAUDE. Alternative : une **retry** + **échec explicite** si `result` vide après N tentatives (évite de lancer Dev sans cadrage). |
| 4 | **Corriger le solo `--brief-file`** | Combiner `briefFromFile` avec `taskFromCli` : par ex. `additionalContext: briefFromFile` et **tâche** = `taskFromCli` (ou l’inverse selon convention), au lieu de `task = briefFromFile ?? …`. |
| 5 | **Modularisation** | Une fois `workflows.ts` / `agent-runner.ts` extraits, regrouper les **deux appels** `runAgent("architect", …)` (backlog reflection vs execution) dans des helpers nommés `runArchitectForBacklogReflection` / `runArchitectForTicketExecution` pour documenter le contrat en un seul endroit. |

Ces items peuvent être des **PR séparées** après la modularisation de base, ou une PR « produit » dédiée avant PR 6 si le fichier est encore monolithique.

## Plan en PRs (ordre)

### PR 1 — Utilities + project loader (risque très faible)

- Extraire : `formatErrorMessage`, `previewText`, `resolveUserPath`, `loadProject`, éventuellement `loadPrompt`.
- Aucun changement de flux ; uniquement déplacements + imports.
- **Validation :** `npx tsc --noEmit`, `npm test`, smoke `npm run start -- --help` ou équivalent.

### PR 2 — Run context + URLs

- Extraire : `LastRunContext`, load/save, `detectGitHubBranchUrl` / PR, migration legacy fichier security.
- **Validation :** idem + lancer une commande `--project` minimale si possible (sans API).

### PR 3 — Branch guard

- Extraire toute la logique mismatch / resync trunk (déjà reliée à `project-branch-url.ts`).
- **Validation :** idem ; idéalement un test unitaire ciblant la garde si on expose une fonction pure testable (sinon reporter à PR 4).

### PR 4 — Context builders + git sync

- Extraire `buildSecurityImplementationContext`, `buildQAPipelineContext`, puis `syncLocalGitBeforeAgent` et helpers.
- **Validation :** `npm test` + un run local non-cloud si dispo.

### PR 5 — Agent runner

- Extraire `runAgent` (+ dépendances directes). C’est souvent la PR la plus touchy (beaucoup d’imports).
- Si besoin : introduire `session.ts` ou premier passage de `OrchestratorRuntime`.

### PR 6 — Workflows + CLI

- Extraire `fullPipeline`, `pipelineNext`, `pipelineBacklogReflection`, `pmBacklogWorkflow`.
- Extraire `main()` / parsing args dans `cli.ts`.
- Laisser `orchestrator.ts` comme : `import './cli.js'` ou `main()` thin wrapper.

### PR 7 — Session explicite ✅

- ~~Remplacer globals par un type `OrchestratorSession` passé aux workflows.~~ Fait : `OrchestratorSession` + `emptyOrchestratorSession()` dans `session.ts`, instance créée dans `cli.main()` et transmise à `runAgent`, backlog-io, run-context, git-sync, branch-guard, context-builders, workflows.

## Critères de done (global)

- `orchestrator.ts` < ~200–300 lignes **ou** documenté comme simple façade.
- Aucune régression sur les chemins `last-run`, `run-context`, backlog.
- README / CLAUDE : une phrase sur la nouvelle structure `src/orchestrator/*` si les fichiers bougent beaucoup.

## Risques / mitigations

- **Globals** : facilitent les PRs courtes mais gèlent la testabilité → PR 7 ou `session.ts` tôt si tu ajoutes des tests d’intégration.
- **Imports circulaires** : garder les dépendances en sens unique `cli → workflows → agent-runner → …` ; éviter que `run-context` importe `workflows`.
- **Couverture tests** : le repo teste surtout des modules isolés ; smoke manuel utile après PR 5–6.

## Suivi

Cocher les PRs au fil de l’eau ; ne pas mélanger refacto et nouvelles features dans la même branche.