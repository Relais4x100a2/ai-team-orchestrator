---
name: Nom du projet
# repo HTTPS GitHub — requis pour cloud, --pipeline backlog, --sync-issues, --pull-issues et sync GitHub au pipeline next
repo: https://github.com/org/repo-name
branch: main
# local_path (optionnel) : clone local pour agents locaux ; sans lui, données sous last-run/<slug>/ et contexte = corps ci-dessous
# local_path: ~/code_dev/repo-name
# project_data_dir (optionnel, relatif au clone ; défaut .ai-team-orchestrator) :
# project_data_dir: .ai-team-orchestrator
# project_context (optionnel, relatif à project_data_dir ; sinon context.md puis corps ci-dessous) :
# project_context: context.md
# coverage_lines_pct (optionnel, 0–100) : cible de couverture injectée au QA
# coverage_lines_pct: 80
# work_branch (optionnel) : branche fixe réutilisée à chaque pipeline next (ex. ai-team/pipeline)
# Sans ce champ, une branche backlog/<id>-<slug> est créée par issue.
# work_branch: ai-team/pipeline
# Avec local_path : npm run migrate:project-context copie ce corps vers context.md et ne garde que le frontmatter ici
# Gabarit dédié (commande globale /scaffold-context) : projects/_template.context.md
---

## Vue d'ensemble

Brève description du projet et de ses objectifs.

## Stack technique

| Couche       | Technologie              | Notes                          |
|-------------|--------------------------|--------------------------------|
| Frontend    | [Framework]              | [Détails]                      |
| Backend     | [Langage]                | [Framework/runtime]            |
| BDD         | [DB]                     | [Options]                      |
| Conteneur   | Docker                   | [Notes sur la conteneurisation]|
| Déploiement | [Plateforme]             | [Configuration]                |
| CI/CD       | GitHub Actions           | [Ou autre]                     |
| Versioning  | Git + GitHub             | Branches et workflow            |

## Structure du repo

```
repo-name/
├── README.md
├── [Configuration files]
├── src/
│   └── [Source organization]
├── tests/
│   └── [Test structure]
└── [Other directories]
```

## Conventions

- **Langue du code** : [ex: anglais]
- **Langue des UIs** : [ex: français]
- **Commits** : [ex: conventionnel]
- **Branches** : [ex: feature/, fix/]
- **Linting/Formatting** : [ex: ruff, prettier]
- **Tests** : [Framework et couverture minimum]

## Déploiement

Détails du processus de déploiement sur la plateforme cible.

## Contraintes importantes

1. [Contrainte 1]
2. [Contrainte 2]
3. [Contrainte 3]
