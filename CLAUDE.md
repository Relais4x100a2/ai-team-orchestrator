# CLAUDE.md — Contexte pour Claude Code

## Ce projet

Ceci est un orchestrateur d'équipe de dev IA. Il utilise le Cursor SDK
pour piloter des agents spécialisés sur un repo GitHub cible.

**Pipeline par défaut (`full`) :** PM → architecte → dev ⇄ QA ⇄ red team.

**Agents hors pipeline `full` (invocation manuelle)** : `ux`, `ui`, `devops`, `sre`, `release`, `techwriter`, `privacy` — même injection de contexte que les autres agents quand `--project` est utilisé.

## Stack

- TypeScript (Node.js) pour l'orchestrateur
- Cursor SDK (@cursor/sdk) pour les agents
- Modèles : `MODEL_STRONG` et `MODEL_FAST` dans `.env` (résolus dans `createAgentConfig()` / `src/agent-config.ts`, consommé par `src/orchestrator.ts`)
- Projets **cibles** multiples (configuration via `projects/*.md`)

## Agents : clés CLI (`--role`) ⇄ fichier prompt

| `--role`   | `promptFile` (`src/prompts/<fichier>.md`) |
|------------|--------------------------------------------|
| `pm`       | `product-manager`                          |
| `architect`| `data-architect`                           |
| `ux`       | `ux-designer`                              |
| `dev`      | `fullstack-dev`                            |
| `qa`       | `qa-engineer`                              |
| `redteam`  | `red-team`                                 |
| `devops`   | `devops-platform`                          |
| `sre`      | `sre-observability`                        |
| `release`  | `release-manager`                          |
| `ui`       | `ui-designer`                              |
| `techwriter` | `technical-writer`                       |
| `privacy`  | `privacy-by-design`                        |

Ajouter ou renommer un agent : même nom de base pour la clé, le fichier `.md`, et l’entrée correspondante dans `AGENT_DEFINITIONS` (`src/agent-config.ts`). La CI vérifie leur présence avec `npm run verify:prompts`.

## Commandes utiles

```bash
npm install          # Dépendances
npm run build        # tsc — compile le projet
npx tsc --noEmit     # Vérification types sans écrire de fichiers (obligatoire avant changement TS)
npm test             # Tests (backlog PM, verdicts pipeline) — `tsx --test`
npm run verify:prompts  # Vérifie que tous les `src/prompts/*.md` référencés existent

npm run start        # Aide interactive + liste des rôles (--role)

# Pipeline (inchangé) : PM → Architect → Dev ⇄ QA ⇄ Red Team
npm run pipeline     # équivalent à --pipeline full
npm run pipeline:next # prochaine issue du backlog.json

npm run pm:backlog   # PM en cloud → enrichit backlog.json
npm run backlog      # Synthèse du backlog

# Agents (mode cloud avec repo cible : .env ou --project …)
npm run agent:pm
npm run agent:architect
npm run agent:ux
npm run agent:dev
npm run agent:qa
npm run agent:redteam
npm run agent:devops
npm run agent:sre
npm run agent:release
npm run agent:ui
npm run agent:techwriter
npm run agent:privacy
```

Projet chargé :

```bash
npm run project:dataset-style -- --role devops "Proposer CI pour le repo du frontmatter"
```

## Structure

- `src/orchestrator.ts` — Script principal (`fullPipeline`, `runAgent`)
- `src/agent-config.ts` — Définition des rôles, `promptFile`, résolution des modèles
- `src/backlog.ts` — Parse sortie PM + sélection prochaine issue (`pickNextIssue`)
- `src/pipeline-detection.ts` — Heuristiques `detectQAVerdict` / `detectSecurityVerdict`
- `src/verify-prompts.ts` — Vérif présence des fichiers prompts (CI + `npm run verify:prompts`)
- `src/prompts/*.md` — Prompts système génériques (liste dans le tableau ci-dessus)
- `projects/*.md` — Fichiers de contexte projet (stack, conventions, contraintes)
- `.cursor/mcp.json` — Serveurs MCP (Figma, GitHub)
- `.cursor/hooks.json` — Hooks de supervision

## Architecture multi-projets

Chaque projet a son propre fichier `projects/<nom>.md` avec frontmatter YAML:

```yaml
---
name: Nom du projet
repo: https://github.com/org/repo
branch: main
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

Le `fullPipeline` ne couvre pas CI/CD, Docker ni la config d’observabilité produite par `devops` / `sre`. Avant merge sur le dépôt cible : revue humaine ciblée et/ou Red Team sur le diff infra, protections de branches, checklist workflows et conteneurs — voir [README.md](README.md) (section « Chaîne assurance »).

Évolution possible plus tard : `--pipeline extended` **sans** modifier le comportement actuel du `full`.

## Règles pour Claude Code

- Les prompts `src/prompts/*.md` sont maintenant **génériques et agnostiques**.
  - Ne les modifie que si tu améliores la mécanique d'un rôle (PM, Architect, etc.)
  - Les références spécifiques au projet viennent du fichier `projects/*.md`, pas du prompt.
- Les fichiers `projects/*.md` peuvent être librement créés et modifiés pour ajouter de nouveaux projets.
- Tu peux modifier `src/orchestrator.ts` pour ajouter des fonctionnalités (flags, pipelines, etc.).
- Teste toujours avec `npx tsc --noEmit` avant de proposer un changement.
- Si tu ajoutes un agent, crée son prompt dans `src/prompts/` ET sa config dans `AGENT_CONFIG`.
- Ne touche PAS à la logique des pipelines (PM → Architect → Dev ⇄ QA ⇄ RedTeam).
  Les feedback loops sont critiques pour la qualité.
- Les sorties **DevOps / SRE** (et tout diff CI/CD, Docker, observabilité) produites hors `fullPipeline` exigent une **révision assurance** humaine ou un passage Red Team ciblé avant merge sur le dépôt cible — section « Chaîne assurance » ci-dessus et détail dans le README.
