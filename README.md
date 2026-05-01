# 🤖 AI Team Orchestrator

Orchestrateur d'équipe de développement IA basé sur le [Cursor SDK](https://cursor.com/docs/sdk/typescript).

Transforme une idée en code déployé, en passant par 5 agents spécialisés :
**PM → Architecte → Dev → QA → Red Team**.

## 🏗️ Architecture

```
Toi (super-superviseur)
  │
  ▼
Cursor SDK (orchestrateur TypeScript)
  │
  ├── 📋 PM Agent         → Specs & user stories
  ├── 🏛️ Architect Agent   → Modèle de données & architecture
  ├── 💻 Dev Agent         → Implémentation (PR auto)
  ├── 🧪 QA Agent          → Review & tests
  └── 🔴 Red Team Agent    → Audit sécurité
  │
  ▼
GitHub (Issues, PRs, Actions)
  │
  ▼
CapRover / Hetzner (déploiement)
```

## 🚀 Démarrage rapide

### 1. Prérequis

- Node.js 20+
- Un compte Cursor avec une clé API
- Un repo GitHub cible (ex: dataset_style)

### 2. Installation

```bash
git clone https://github.com/TON_USERNAME/ai-team-orchestrator.git
cd ai-team-orchestrator
npm install
cp .env.example .env
# Édite .env avec ta clé API Cursor et ton token GitHub
```

### 3. Premier lancement

```bash
# Lancer un agent seul pour tester
npm run agent:pm "Ajouter une page d'upload de fichiers CSV avec validation"

# Lancer le pipeline complet
npm run pipeline "Créer une fonctionnalité d'import de dataset CSV
avec prévisualisation, validation des colonnes, et stockage en BDD"
```

## 📁 Structure du projet

```
ai-team-orchestrator/
├── src/
│   ├── orchestrator.ts       # 🧠 Script principal (le cerveau)
│   └── prompts/              # 🎭 Prompts des agents (le cœur)
│       ├── product-manager.md
│       ├── data-architect.md
│       ├── ux-designer.md
│       ├── fullstack-dev.md
│       ├── qa-engineer.md
│       └── red-team.md
├── .cursor/
│   ├── mcp.json              # 🔌 Connexions MCP (Figma, GitHub)
│   ├── hooks.json             # 🛑 Hooks de supervision
│   └── skills/
│       └── project-context.md # 📖 Contexte partagé par tous les agents
├── .github/
│   └── workflows/
│       └── ci.yml             # ⚙️ CI pour l'orchestrateur
├── CLAUDE.md                  # 📝 Contexte pour Claude Code
├── package.json
├── tsconfig.json
└── .env.example
```

## 🎯 Comment ça marche

### Mode agent unique

Lance un seul agent pour une tâche spécifique :

```bash
# Le PM rédige les specs
npm run agent:pm "Je veux un dashboard de statistiques sur les datasets"

# L'architecte conçoit le modèle de données
npm run agent:architect "Conçois le schéma BDD pour stocker des datasets CSV"

# Le dev implémente
npm run agent:dev "Implémente la page de visualisation des datasets"

# Le QA review
npm run agent:qa "Review la PR #12"

# La red team audite
npm run agent:redteam "Audite la sécurité de l'upload de fichiers"
```

### Mode pipeline complet

Lance les 5 agents en séquence, chacun recevant le contexte du précédent :

```bash
npm run pipeline "Brief de la fonctionnalité complète"
```

Le pipeline s'arrête à chaque **checkpoint** pour ta validation
(via les hooks Cursor).

## ✏️ Personnaliser les agents

Les prompts dans `src/prompts/` sont le levier principal. Pour ajuster
le comportement d'un agent :

1. Ouvre le fichier `.md` correspondant
2. Modifie les instructions, le format de sortie, ou les règles
3. Relance l'agent — pas besoin de recompiler

### Ajouter un nouvel agent

1. Crée `src/prompts/mon-agent.md` avec le prompt
2. Ajoute sa config dans `AGENT_CONFIG` dans `orchestrator.ts`
3. Ajoute le script npm dans `package.json` si voulu

## 🔧 Avec Claude Code

Ce projet est aussi utilisable avec Claude Code comme complément :

```bash
# Depuis le dossier du projet
claude "Ajoute un agent de documentation qui génère les docstrings manquantes"
```

Le fichier `CLAUDE.md` donne le contexte nécessaire à Claude Code.

## 📌 Conseils pour le super-superviseur

1. **Commence petit** : teste un agent seul avant le pipeline complet
2. **Affine les prompts** : c'est là que se joue 80% de la qualité
3. **Review les PRs** : ne merge jamais sans lire le diff
4. **Itère** : si un agent produit un résultat moyen, ajuste son prompt
5. **Combine les outils** : utilise Cursor IDE pour le pair programming,
   l'orchestrateur pour l'automatisation, Claude Code pour le one-shot
