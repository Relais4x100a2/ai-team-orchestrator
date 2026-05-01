# CLAUDE.md — Contexte pour Claude Code

## Ce projet

Ceci est un orchestrateur d'équipe de dev IA. Il utilise le Cursor SDK
pour piloter des agents spécialisés (PM, architecte, dev, QA, red team)
qui travaillent sur un repo GitHub cible.

## Stack

- TypeScript (Node.js) pour l'orchestrateur
- Cursor SDK (@cursor/sdk) pour les agents
- Projets CIBLES multiples (configuration via `projects/*.md`)

## Commandes utiles

```bash
npm install          # Installer les dépendances
npm run start        # Lancer le menu d'aide
npm run agent:pm     # Lancer l'agent PM
npm run pipeline     # Lancer le pipeline complet
npm run build        # Compiler le TypeScript
```

## Structure

- `src/orchestrator.ts` — Script principal, orchestre les agents
- `src/prompts/*.md` — Prompts système de chaque agent (génériques, agnostiques au projet)
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
