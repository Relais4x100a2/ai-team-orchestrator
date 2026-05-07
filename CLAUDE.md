# CLAUDE.md — Contexte pour Claude Code

## Ce projet

Ceci est un orchestrateur d'équipe de dev IA. Il utilise le Cursor SDK
pour piloter des agents spécialisés sur un repo GitHub cible.

**Pipeline par défaut (`full`) :** PM → architecte → red team réflexion → dev ⇄ sécurité ⇄ QA (sécurité avant QA, variante A).

**Agents hors pipeline `full` (invocation manuelle)** : `ux`, `ui`, `devops`, `sre`, `release`, `techwriter`, `privacy` — même injection de contexte que les autres agents quand `--project` est utilisé.

## Stack

- TypeScript (Node.js) pour l'orchestrateur
- Cursor SDK (@cursor/sdk) pour les agents
- Modèles : `MODEL_STRONG` / `MODEL_FAST` et `MODEL_<ROLE>` dans `.env`, résolus dans `resolveRunModel()` (`src/agent-config.ts`) — utilisé par `runAgent` et par `createAgentConfig()` (invocations sans taille d'issue). Sur `pipeline next`, la **taille d'issue** du backlog (`S`/`M`/`L`/`XL`) applique une grille coût/qualité pour les rôles pipeline et détermine le point d'entrée d'exécution (`dev` pour `S`, `architect` pour `M/L/XL`).
- Projets **cibles** multiples (configuration via `projects/*.md`)
- **Variables `.env` utiles**
  - `CURSOR_API_KEY` — obligatoire pour lancer les agents
  - `TARGET_REPO_URL`, `TARGET_BRANCH` — fallback si pas de `--project` (mode cloud)
  - `GITHUB_TOKEN` — pour `--sync-issues` (API Issues) et, si `GITHUB_CLOSE_ISSUE_ON_PIPELINE_DONE=1` (opt-in), fermeture automatique de l’issue GitHub après un `pipeline next` réussi (`src/github-sync.ts`, `src/orchestrator.ts`)
  - `CURSOR_BILLING_MODE` — `solo` (défaut recommandé Pro/Pro+/Ultra) ou `team`.
  - `FRUGAL_DEFAULT` — override explicite (`true|false`) du mode frugal.
  - `SPEND_ALERT_CENTS` — seuil Team (centimes) ; au-delà, **mode frugal** : tous les agents utilisent `composer-2` (`src/spend-guard.ts`). Optionnel : `SPEND_CHECK_EMAIL` pour filtrer la dépense par utilisateur.
  - `CLOUD_AGENT_COOLDOWN_MS`, `CLOUD_AGENT_MAX_RETRIES` — pacing et retries cloud (anti-burst) dans `src/cloud-policy.ts`.
  - `BRANCH_MISMATCH_POLICY` / `BRANCH_MISMATCH_TRUNK_BRANCHES` — cohérence `branch:` projet vs `last-run/<slug>/run-context.json` ; si la branche projet est une trunk (défaut `main`,`master`,`trunk`), réalignement auto du fichier après merge de PR (`src/project-branch-url.ts`, `src/orchestrator.ts`).

## Agents : clés CLI (`--role`) ⇄ fichier prompt

| `--role`   | `promptFile` (`src/prompts/<fichier>.md`) |
|------------|--------------------------------------------|
| `pm`       | `product-manager`                          |
| `architect`| `data-architect`                           |
| `ux`       | `ux-designer`                              |
| `dev`      | `fullstack-dev`                            |
| `qa`       | `qa-engineer`                              |
| `redteam_reflection` | `red-team-reflection`               |
| `security` | `red-team`                                 |
| `devops`   | `devops-platform`                          |
| `sre`      | `sre-observability`                        |
| `release`  | `release-manager`                          |
| `ui`       | `ui-designer`                              |
| `techwriter` | `technical-writer`                       |
| `privacy`  | `privacy-by-design`                        |

Ajout ou renommage d’un agent : voir « Règles pour Claude Code » (prompt + `AGENT_DEFINITIONS`, CI `npm run verify:prompts`).

## Commandes utiles

```bash
npm install          # Dépendances
npm run build        # tsc — compile le projet
npx tsc --noEmit     # Vérification types sans écrire de fichiers (obligatoire avant changement TS)
npm test             # Tests (backlog PM, verdicts pipeline) — `tsx --test`
npm run verify:prompts  # Vérifie que tous les `src/prompts/*.md` référencés existent

npm run start        # Aide interactive + liste des rôles (--role)

# Pipeline full : PM → Architect → Red Team Réflexion → Dev ⇄ Sécurité ⇄ QA
npm run pipeline     # équivalent à --pipeline full
npm run pipeline:next # prochaine issue du backlog.json
npm run project -- monprojet --pipeline backlog forward "Meta-vision"
npm run project -- monprojet --pipeline backlog backward "Feedback"

npm run pm:backlog   # PM en cloud → enrichit backlog.json
npm run backlog      # Synthèse du backlog

# Agents (mode cloud avec repo cible : .env ou --project …)
npm run agent:pm
npm run agent:architect
npm run agent:ux
npm run agent:dev
npm run agent:qa
npm run agent:redteam_reflection
npm run agent:security
npm run agent:devops
npm run agent:sre
npm run agent:release
npm run agent:ui
npm run agent:techwriter
npm run agent:privacy
```

### Options globales (à passer après `--` avec les scripts `npm run`, ou sur la ligne `tsx`)

| Option | Rôle |
|--------|------|
| `--project <fichier>` | Charge `projects/…`. Fichier `last-run/<slug>/` pour les sorties et le backlog dédié. |
| `--brief-file <fichier>` | Brief ou tâche lus depuis un fichier (chemins relatifs au cwd ou absolus). Utile avec `last-run/<slug>/pm.md`. |
| `--resume-from <étape>` | Reprend le pipeline : `pm` \| `architect` \| `redteam_reflection` \| `dev` \| `security` \| `qa`. Le brief fourni remplace le contexte des étapes ignorées. (`pipeline next` démarre par défaut en exécution: `dev` pour `S`, `architect` pour `M/L/XL`) |
| `--sync-issues` | Crée les issues GitHub manquantes depuis `backlog.json`. Exige `--project` avec `repo:` dans le frontmatter et `GITHUB_TOKEN` dans `.env`. |

Exemples :

```bash
npm run project -- dataset-style --role devops "Proposer CI pour le repo du frontmatter"

npm run project -- dataset-style --pipeline full --brief-file last-run/dataset-style/pm.md --resume-from architect

tsx src/orchestrator.ts --project projects/mon-projet.md --sync-issues
```

(`npm run sync:issues` appelle `--sync-issues` sans `--project` ; sans variables de secours adaptées, préférer une ligne `tsx … --project … --sync-issues`.)

## Structure

- `src/orchestrator.ts` — Script principal (`fullPipeline`, `runAgent`)
- `src/agent-config.ts` — `AGENT_DEFINITIONS`, `promptFile`, résolution des modèles (`createAgentConfig`)
- `src/models.ts` — Types partagés (`ProjectContext`, backlog, pipeline runs, parsing JSON)
- `src/backlog.ts` — Parse sortie PM + sélection prochaine issue (`pickNextIssue`)
- `src/pipeline-detection.ts` — Heuristiques `detectQAVerdict` / `detectSecurityVerdict` (dernière ligne `VERDICT QA:` / `VERDICT:` pour le QA ; `VERDICT SÉCURITÉ:` pour la sécurité)
- `src/pipeline-runs.ts` — Persistance des exécutions dans `pipeline-runs.json` (racine du repo)
- `src/github-sync.ts` — Création des issues GitHub depuis le backlog (`--sync-issues`)
- `src/spend-guard.ts` — Mode frugal selon `SPEND_ALERT_CENTS`
- `src/verify-prompts.ts` — Vérif présence des fichiers prompts (CI + `npm run verify:prompts`)
- `src/prompts/*.md` — Prompts système génériques (liste dans le tableau ci-dessus)
- `projects/*.md` — Fichiers de contexte projet (stack, conventions, contraintes)
- `last-run/<slug>/` — Avec `--project` : une sortie `<role>.md` par agent et `backlog.json` du projet
- `pipeline-runs.json` — Journal des runs de `fullPipeline` (append)
- `.cursor/mcp.json` — Serveurs MCP (Figma, GitHub)
- `.cursor/hooks.json` — Hooks de supervision

## Architecture multi-projets

Chaque projet a son propre fichier `projects/<nom>.md` avec frontmatter YAML :

```yaml
---
name: Nom du projet
repo: https://github.com/org/repo
branch: main
# optionnel — répertoire de travail pour le mode **local** (agents sans cloud) :
# local_path: ~/code/dev/mon-repo
---

## Stack technique
[Description...]

## Conventions
[Description...]

## Déploiement
[Description...]
```

Au démarrage, l'orchestrateur peut charger un projet via `--project projects/nom.md`.
Le contexte du projet est alors injecté dans **tous les prompts des agents**,
ce qui rend les agents génériques et adaptables à n'importe quelle stack.

## Chaîne assurance (rappel)

Le `fullPipeline` ne couvre pas CI/CD, Docker ni la config d’observabilité produite par `devops` / `sre`. Avant merge sur le dépôt cible : revue humaine ciblée et/ou audit sécurité ciblé sur le diff infra, protections de branches, checklist workflows et conteneurs — voir [README.md](README.md) (section « Chaîne assurance »).

*Roadmap non implémentée : un `--pipeline extended` pourrait un jour enrichir le flux sans modifier le comportement par défaut du `full`.*

## Règles pour Claude Code

- Les prompts `src/prompts/*.md` sont **génériques et agnostiques**.
  - Ne les modifie que si tu améliores la mécanique d'un rôle (PM, Architect, etc.)
  - Les références spécifiques au projet viennent du fichier `projects/*.md`, pas du prompt.
- Les fichiers `projects/*.md` peuvent être librement créés et modifiés pour ajouter de nouveaux projets.
- Tu peux modifier `src/orchestrator.ts` pour ajouter des fonctionnalités (flags, pipelines, etc.).
- Les types et schémas partagés du domaine (backlog, pipeline runs, projet) vivent dans **`src/models.ts`** — évite de dupliquer ces définitions ailleurs.
- Teste toujours avec `npx tsc --noEmit` avant de proposer un changement TS.
- **Nouvel agent** : créer `src/prompts/<base>.md`, ajouter une entrée dans **`AGENT_DEFINITIONS`** (`src/agent-config.ts`) avec la même base de nom pour la clé rôle et `promptFile`, et une clé `MODEL_<ROLE>` dans `perRoleEnvKey` si besoin d’override env. La CI vérifie les fichiers avec `npm run verify:prompts`.
- Ne touche PAS à la logique des pipelines (PM → Architect → Red Team Réflexion → Dev ⇄ Sécurité ⇄ QA).
  Les feedback loops sont critiques pour la qualité.
- Avec `--project`, les sorties sont écrites dans `last-run/<slug>/<role>.md` (un fichier par rôle ; deux runs parallèles sur le même rôle s’écrasent — usage prévu mono-session).
- Les sorties **DevOps / SRE** (et tout diff CI/CD, Docker, observabilité) produites hors `fullPipeline` exigent une **révision assurance** humaine ou un passage sécurité ciblé avant merge sur le dépôt cible — section « Chaîne assurance » ci-dessus et détail dans le README.
