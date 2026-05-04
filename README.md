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
# Créer un fichier projet (copier depuis le template)
cp projects/_template.md projects/monprojet.md
# Remplir le frontmatter : name, repo, branch, local_path

# Lancer un agent seul pour tester
npm run project -- monprojet --role pm "Ajouter une page d'upload"

# Lancer le pipeline complet
npm run project -- monprojet --pipeline full \
  "Créer une fonctionnalité d'import de dataset CSV avec prévisualisation et validation"
```

### 4. Vérifications locales (contributeurs)

- `npx tsc --noEmit` — typage TypeScript (idem CI).
- `npm test` — tests sur le parse backlog PM et les heuristiques QA / Red Team.
- `npm run verify:prompts` — confirme la présence de tous les fichiers `src/prompts/*.md` référencés par les rôles agents.

## 📁 Structure du projet

```
ai-team-orchestrator/
├── src/
│   ├── models.ts             # 📐 Schéma backlog / pipeline (validation stricte)
│   ├── pipeline-runs.ts      # 📝 Append des exécutions pipeline → pipeline-runs.json
│   ├── orchestrator.ts       # 🧠 Script principal (le cerveau)
│   ├── agent-config.ts       # 📋 Prompts / `resolveRunModel` (grille S–XL + MODEL_*)
│   ├── spend-guard.ts        # 💰 Garde-fou budgétaire (SPEND_ALERT_CENTS)
│   ├── backlog.ts            # 📦 Parse backlog & sélection « next » issue
│   ├── pipeline-detection.ts # ✅ Heuristiques verdict QA / Red Team
│   ├── verify-prompts.ts     # CI : vérifie la présence des fichiers prompts
│   ├── *.test.ts             # Tests (runner `tsx --test`)
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
├── tests/                    # Tests unitaires (node:test + tsx)
├── projects/                 # 📂 Contexte spécifique par projet (non versionné sauf _template.md)
│   └── _template.md          # Template à copier pour chaque projet
├── .cursor/
│   ├── mcp.json              # 🔌 Connexions MCP (Figma, GitHub)
│   ├── hooks.json             # 🛑 Hooks de supervision
├── .github/
│   └── workflows/
│       └── ci.yml             # ⚙️ CI pour l'orchestrateur
├── last-run/                  # 💾 Sauvegardes auto des sorties (non versionné)
├── CLAUDE.md                  # 📝 Contexte pour Claude Code
├── package.json
├── tsconfig.json
├── backlog.json              # 📋 État du backlog (généré localement, non versionné)
├── pipeline-runs.json        # 📜 Historique des exécutions `pipeline full` (local, non versionné)
└── .env.example
```

### Persistance locale (backlog & exécutions pipeline)

- **`backlog.json`** : à chaque lecture, le contenu est validé (enums `status` / `priority` / `size`, dates ISO 8601, unicité des `id`). Un fichier corrompu ou mal typé provoque une erreur explicite plutôt qu’une corruption silencieuse.
- **`pipeline-runs.json`** : chaque exécution de `npm run pipeline` (hors sous-commande `next`) ajoute une ligne d’historique avec `id`, brief (tronqué au-delà de ~50 ko), reprise éventuelle (`resumeFrom`), nombre d’itérations QA / Red Team, statut `success` | `partial` | `failed`, et horodatages.
- **`pipeline:next`** : l’issue en cours reçoit `pipelineRun` = identifiant d’exécution (`run-<timestamp>-<suffix>`), réinitialisé si le pipeline échoue avant la fin.

## 🎯 Architecture multi-projets

L'orchestrateur est **agnostique** — il peut travailler sur n'importe quelle stack :

- **Python + Streamlit** (dataset_style)
- **React + Node.js** (autre projet)
- **Django + PostgreSQL** (autre projet)
- etc.

Chaque projet a un fichier `projects/<nom>.md` avec frontmatter YAML :

```yaml
---
name: Mon Projet
repo: https://github.com/org/mon-projet
branch: main
local_path: ~/code_dev/mon-projet   # optionnel — chemin local vers le repo cloné
---

## Stack technique
[Description...]

## Conventions
[Description...]

## Déploiement
[Description...]
```

Au démarrage avec `npm run project -- monprojet` :
- Le contexte est **injecté dans tous les prompts** des agents
- `local_path` devient le **répertoire de travail** des agents locaux (PM, Architect) — ils voient et lisent le vrai code source
- `repo` + `branch` définissent la cible des agents cloud (Dev, QA, Red Team)

### Ajouter un nouveau projet

1. Copie `projects/_template.md` en `projects/monprojet.md`
2. Remplis le frontmatter YAML : `name`, `repo`, `branch`, et `local_path` (chemin vers le repo cloné localement — permet aux agents locaux de lire le vrai code source)
3. Ajoute les sections : Stack technique, Conventions, Déploiement, Contraintes
4. Lance : `npm run project -- monprojet --role pm "..."`

> `projects/*.md` sont dans `.gitignore` (sauf `_template.md`) — tes informations de projet restent locales.

## 🎯 Comment ça marche

### Mode agent unique

Lance un seul agent pour une tâche spécifique :

```bash
# --project est obligatoire (la sortie est sauvegardée dans last-run/<slug>/<role>.md)
npm run project -- monprojet --role pm "Je veux un dashboard de statistiques"
npm run project -- monprojet --role architect "Conçois le schéma BDD"
npm run project -- monprojet --role dev "Implémente la page"
npm run project -- monprojet --role qa "Review la PR #12"
npm run project -- monprojet --role redteam "Audite la sécurité"
npm run project -- monprojet --role ux "Esquisse les parcours"
npm run project -- monprojet --role devops "Propose la CI"
```

### Mode pipeline complet

Lance les 5 agents en séquence, chacun recevant le contexte du précédent :

```bash
# --project est obligatoire
npm run project -- monprojet --pipeline full "Brief de la fonctionnalité"

# Pipeline avec backlog (prend la prochaine issue dans le backlog)
npm run project -- monprojet --pipeline next
```

**Reprise et fichiers de brief :**
Après chaque exécution d’un agent, sa sortie est automatiquement sauvegardée dans `last-run/<slug>/<role>.md` (où `<slug>` est le nom du fichier projet sans `.md`). Ces fichiers permettent de reprendre le pipeline sans repasser par les étapes précédentes.

```bash
# Lancer le PM pour générer le brief (sauvegardé dans last-run/monprojet/pm.md)
npm run project -- monprojet --role pm "Brief initial..."

# Reprendre à partir de l’architecte avec la sortie du PM
npm run project -- monprojet --pipeline full \
  --brief-file last-run/monprojet/pm.md --resume-from architect

# Reprendre depuis le dev après avoir ajusté l’architecture manuellement
npm run project -- monprojet --pipeline full \
  --brief-file last-run/monprojet/architect.md --resume-from dev
```

**Mode d’exécution :** les étapes **Product Manager** et **Data Architect** tournent en **local** dans le répertoire défini par `local_path` du fichier projet (ou le cwd de l’orchestrateur si absent). À partir du **Développeur**, le pipeline utilise **cloud** Cursor contre le repo cible défini par `repo:` dans le fichier projet.

Le pipeline inclut une **boucle de feedback** :
- QA approuve → continue vers RedTeam
- QA demande changements → relance Dev, puis re-review (max 3 itérations)
- RedTeam détecte failles critiques → relance Dev, puis re-audit (max 3 itérations)
- RedTeam détecte failles mineures → passage avec documentation

Le pipeline s'arrête à chaque **checkpoint** pour ta validation
(via les hooks Cursor).

### Agents hors pipeline

Les rôles **`ux`**, **`ui`**, **`devops`**, **`sre`**, **`release`**, **`techwriter`**, **`privacy`** se lancent comme n'importe quel autre agent avec `--role <clé>`. Ils ne sont **pas** enchaînés automatiquement après `fullPipeline`.

```bash
npm run project -- monprojet --role devops "Propose la CI GitHub Actions"
npm run project -- monprojet --role techwriter "Met à jour le README"
```

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
