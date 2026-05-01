# 🤖 AI Team Orchestrator

Orchestrateur d'équipe de développement IA basé sur le [Cursor SDK](https://cursor.com/docs/sdk/typescript).

Transforme une idée en code déployé via le pipeline par défaut (**5 étapes**) :
**PM → Architecte → Dev → QA → Red Team**.

D’**autres agents** (UX, UI, DevOps, SRE, release, rédaction technique, privacy) sont disponibles **à la demande** (`npm run agent:<rôle>`) ; ils ne font pas partie du pipeline `full` pour limiter la durée des runs et éviter les régressions de flux.

## 🏗️ Architecture

```
Toi (super-superviseur)
  │
  ▼
Cursor SDK (orchestrateur TypeScript)
  │
  ├── Pipeline full (séquentiel + boucles QA / Red Team)
  │   ├── 📋 PM → 🏛️ Architect → 💻 Dev ⇄ 🧪 QA ⇄ 🔴 Red Team
  │
  └── Agents à la demande (même injection `projects/*.md`)
      ├── 🎨 UX / UI — parcours & wireframes ; présentation visuelle
      ├── ⚙️ DevOps / SRE — CI/CD, Docker, observabilité
      ├── 📦 Release — versioning & changelog
      ├── ✍️ Tech writer — guides utilisateur & doc publique
      └── 🔒 Privacy — privacy by design (produit & données)
  │
  ▼
GitHub (Issues, PRs, Actions)
  │
  ▼
Infra & déploiement (CI/CD, hébergement, PaaS — selon `projects/*.md`)
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
│   └── prompts/              # 🎭 Prompts des agents (génériques)
│       ├── product-manager.md
│       ├── data-architect.md
│       ├── ux-designer.md
│       ├── ui-designer.md
│       ├── fullstack-dev.md
│       ├── qa-engineer.md
│       ├── red-team.md
│       ├── devops-platform.md
│       ├── sre-observability.md
│       ├── release-manager.md
│       ├── technical-writer.md
│       └── privacy-by-design.md
├── projects/                 # 📂 Contexte spécifique par projet
│   ├── dataset-style.md      # Exemple : Python + Streamlit + CapRover
│   └── _template.md          # Template vide pour nouveau projet
├── .cursor/
│   ├── mcp.json              # 🔌 Connexions MCP (Figma, GitHub)
│   ├── hooks.json             # 🛑 Hooks de supervision
├── .github/
│   └── workflows/
│       └── ci.yml             # ⚙️ CI pour l'orchestrateur
├── CLAUDE.md                  # 📝 Contexte pour Claude Code
├── package.json
├── tsconfig.json
├── backlog.json              # 📋 État du backlog (généré localement, non versionné)
└── .env.example
```

## 🎯 Architecture multi-projets

L'orchestrateur est **agnostique** — il peut travailler sur n'importe quelle stack :

- **Python + Streamlit** (dataset_style)
- **React + Node.js** (autre projet)
- **Django + PostgreSQL** (autre projet)
- etc.

Chaque projet a un fichier `projects/<nom>.md` avec frontmatter YAML :

```yaml
---
name: Dataset Style
repo: https://github.com/Relais4x100a2/dataset_style
branch: deploy/caprover-relais4
---

## Stack technique
[Description...]

## Conventions
[Description...]

## Déploiement
[Description...]
```

Au démarrage avec `--project projects/dataset-style.md`, le contexte du projet
est **injecté automatiquement** dans tous les prompts des agents. Cela rend les agents
génériques et capables de s'adapter à n'importe quelle stack.

### Ajouter un nouveau projet

1. Copie `projects/_template.md` en `projects/monprojet.md`
2. Remplis le frontmatter YAML (name, repo, branch)
3. Ajoute les sections : Stack technique, Conventions, Déploiement, Contraintes
4. Ajoute un script npm dans `package.json` si voulu
5. Lance l’outil avec le projet chargé, par ex. : `npm run start -- --project projects/monprojet.md --role pm "…"` (équivalent : `tsx src/orchestrator.ts --project projects/monprojet.md --role pm "…"`)

## 🎯 Comment ça marche

### Mode agent unique

Lance un seul agent pour une tâche spécifique :

```bash
# Sans projet spécifique (utilise .env)
npm run agent:pm "Je veux un dashboard de statistiques"

# Avec projet spécifique (utilise projects/dataset-style.md)
npm run project:dataset-style -- --role pm "Je veux un dashboard de statistiques"

# Autres agents
npm run agent:ux "Esquisse les parcours pour l’upload CSV"
npm run project:dataset-style -- --role architect "Conçois le schéma BDD"
npm run project:dataset-style -- --role dev "Implémente la page"
npm run project:dataset-style -- --role qa "Review la PR #12"
npm run project:dataset-style -- --role redteam "Audite la sécurité"
```

### Mode pipeline complet

Lance les 5 agents en séquence, chacun recevant le contexte du précédent :

```bash
# Sans projet spécifique
npm run pipeline "Brief de la fonctionnalité complète"

# Avec projet spécifique (+ injectation du contexte dans chaque agent)
npm run project:dataset-style -- --pipeline full "Brief de la fonctionnalité"

# Pipeline avec backlog (prend la prochaine issue dans le backlog)
npm run project:dataset-style -- --pipeline next
```

**Mode d’exécution :** les étapes **Product Manager** et **Data Architect** tournent en **local** sur le répertoire courant de l’orchestrateur (`cwd`). À partir du **Développeur**, le pipeline utilise **cloud** Cursor contre le repo cible défini dans le fichier projet ou `.env` (`TARGET_REPO_URL`).

Le pipeline inclut une **boucle de feedback** :
- QA approuve → continue vers RedTeam
- QA demande changements → relance Dev, puis re-review (max 3 itérations)
- RedTeam détecte failles critiques → relance Dev, puis re-audit (max 3 itérations)
- RedTeam détecte failles mineures → passage avec documentation

Le pipeline s'arrête à chaque **checkpoint** pour ta validation
(via les hooks Cursor).

### Agents hors pipeline (`npm run agent:*`)

Les rôles **`ux`**, **`ui`**, **`devops`**, **`sre`**, **`release`**, **`techwriter`**, **`privacy`** se lancent comme les autres (`npm run agent:devops "…"`, etc., ou `--role <clé>` après `--project …`). Ils ne sont **pas** enchaînés automatiquement après `fullPipeline`.

## 🔐 Chaîne assurance (DevOps / SRE / doc)

Le flux **full** ne couvre pas automatiquement les **artefacts CI/CD, Docker ou observabilité** produits par les agents DevOps ou SRE. **Avant de merger** sur le dépôt cible tout changement issu ou suggéré par ces agents, prévoir au moins une des mesures suivantes (cumulables) :

| Action | Détail |
|--------|--------|
| **Revue avec critères sécu** | Un humain vérifie le diff sous `.github/workflows/`, `Dockerfile*`, Compose, manifests K8s/Helm, règles d’alerte / exporters. |
| **Red Team ciblé** | Tâche dédiée sur le diff **infra / CI / config déploiement** (ne remplace pas la revue humaine sur environnements sensibles). |
| **Protections de branches** | Review obligatoire + CI verte sur les PR qui touchent ces chemins (GitHub / GitLab selon le cas). |

**Checklist minimale (workflows & conteneurs)** — à garder en tête lors des revues :

- Préférer **OIDC / identités fédérées** aux secrets long-lived quand la plateforme le permet ; permissions **minimales** (`GITHUB_TOKEN`, rôles cloud).
- **`permissions:`** aussi restreints que nécessaire ; éviter les motifs risqués non maîtrisés (`pull_request_target` depuis forks, exécution non éprouvée avec secrets).
- **Épinglage** des actions tierces (SHA de commit) ou versioning verrouillé ; images Docker avec **digest** ou tags explicites, rebuild reproductible.
- Pas de secrets en clair dans le repo ; exemples de doc avec **placeholders** clairement fictifs (voir aussi l’agent rédaction technique).
- **Dockerfile** : utilisateur non-root lorsque pertinent, pas de données sensibles en layer, `HEALTHCHECK` si pertinent.

Pour les mises à jour **README / guides produit**, éviter d’exposer des détails internes inutiles (MCP, stratégie d’infra sensible) hors besoin légitime des contributeurs.

Un futur flag du type **`--pipeline extended`** pourrait ajouter des étapes optionnelles **sans modifier** le comportement du `full` actuel ; ce n’est pas implémenté ici.

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
