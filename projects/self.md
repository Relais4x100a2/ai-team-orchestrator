---
name: AI Team Orchestrator
repo: https://github.com/TON_USERNAME/ai-team-orchestrator
branch: main
---

## Stack technique
- TypeScript natif exécuté avec `tsx`
- Node.js 20+
- Cursor SDK `@cursor/sdk` pour l'instanciation des agents cloud et locaux.
- Prompts système sous forme de fichiers Markdown dans `src/prompts/`.

## Conventions
- Pas de classes complexes, on privilégie des fonctions simples et lisibles dans `src/orchestrator.ts`.
- Toujours utiliser `npx tsc --noEmit` pour valider le typage avant de commiter.
- Les dépendances doivent rester minimales (actuellement : `dotenv`, `gray-matter`, `@cursor/sdk`).

## Déploiement
- Outil CLI purement local. Pas de déploiement serveur. 
- Les utilisateurs clonent le repo et exécutent les scripts via `npm run`.