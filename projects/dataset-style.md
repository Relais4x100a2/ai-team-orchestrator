---
name: Dataset Style
repo: https://github.com/Relais4x100a2/dataset_style
branch: deploy/caprover-relais4
---

## Vue d'ensemble

Application web de gestion et manipulation de datasets orientée style/data.
Construite en Python avec Streamlit pour le frontend.

## Stack technique

| Couche       | Technologie              | Notes                          |
|-------------|--------------------------|--------------------------------|
| Frontend    | Streamlit                | Python, widgets natifs         |
| Backend     | Python                   | Logique dans Streamlit ou FastAPI |
| BDD         | PostgreSQL               | Via SQLAlchemy                 |
| Conteneur   | Docker                   | Multi-stage build recommandé   |
| Déploiement | CapRover sur Hetzner     | captain-definition à la racine |
| CI/CD       | GitHub Actions           | Tests + build + deploy         |
| Versioning  | Git + GitHub             | Branches feature/, PRs requises |

## Structure du repo (cible)

```
dataset_style/
├── captain-definition       # Config CapRover
├── Dockerfile               # Build de l'image
├── requirements.txt         # Dépendances Python
├── .env.example             # Variables d'environnement
├── src/
│   ├── app.py               # Point d'entrée Streamlit
│   ├── pages/               # Pages Streamlit (multipage)
│   ├── models/              # Modèles de données (SQLAlchemy)
│   ├── services/            # Logique métier
│   └── utils/               # Fonctions utilitaires
├── tests/
│   ├── test_models.py
│   ├── test_services.py
│   └── conftest.py
└── .github/
    └── workflows/
        └── ci.yml
```

## Conventions

- **Langue du code** : anglais (variables, fonctions, commentaires techniques)
- **Langue des UI** : français (labels, messages utilisateur)
- **Commits** : conventionnel en anglais (`feat:`, `fix:`, `docs:`, `refactor:`)
- **Branches** : `feature/xxx`, `fix/xxx`, `deploy/xxx`
- **Python** : 3.11+, type hints, docstrings Google, ruff pour le linting
- **Tests** : pytest, couverture minimum 70% sur la logique métier

## Déploiement CapRover

Le fichier `captain-definition` pointe vers le Dockerfile.
Le deploy se fait via `caprover deploy` ou via GitHub Actions.
L'app est accessible sur le sous-domaine configuré dans CapRover.

Variables d'environnement à configurer dans CapRover :
- `DATABASE_URL` : URL de connexion PostgreSQL
- `STREAMLIT_SERVER_PORT` : 80 (CapRover attend le port 80)
- Autres variables spécifiques au projet

## Contraintes importantes

1. CapRover expose le port 80 — Streamlit doit être configuré en conséquence
2. Le Dockerfile doit être autonome (pas de volume mount en prod)
3. Les données persistantes passent par PostgreSQL, pas le filesystem
4. HTTPS est géré par CapRover (Let's Encrypt automatique)
