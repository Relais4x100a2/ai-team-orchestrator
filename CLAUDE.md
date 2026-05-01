# CLAUDE.md — Contexte pour Claude Code

## Ce projet

Ceci est un orchestrateur d'équipe de dev IA. Il utilise le Cursor SDK
pour piloter des agents spécialisés (PM, architecte, dev, QA, red team)
qui travaillent sur un repo GitHub cible.

## Stack

- TypeScript (Node.js) pour l'orchestrateur
- Cursor SDK (@cursor/sdk) pour les agents
- Le projet CIBLE est en Python + Streamlit (repo séparé)

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
- `src/prompts/*.md` — Prompts système de chaque agent (le cœur du projet)
- `.cursor/mcp.json` — Serveurs MCP (Figma, GitHub)
- `.cursor/hooks.json` — Hooks de supervision
- `.cursor/skills/` — Contexte projet partagé avec tous les agents

## Règles pour Claude Code

- Ne modifie JAMAIS les prompts sans demander confirmation d'abord.
- Les prompts sont la propriété intellectuelle du super-superviseur.
- Tu peux modifier l'orchestrateur.ts pour ajouter des fonctionnalités.
- Teste toujours avec `npx tsc --noEmit` avant de proposer un changement.
- Si tu ajoutes un agent, crée son prompt dans src/prompts/ ET sa config dans AGENT_CONFIG.
