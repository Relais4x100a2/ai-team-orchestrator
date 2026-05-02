---
name: Intégration agents DevOps-SRE
overview: Ajouter six nouveaux fichiers de prompts et les enregistrer dans `AGENT_CONFIG` avec scripts npm et documentation, sans modifier `fullPipeline` ni la détection QA/Red Team — même comportement pipeline qu’aujourd’hui.
todos:
  - id: add-prompts
    content: Créer les 6 fichiers src/prompts/*.md avec le contenu fourni
    status: completed
  - id: agent-config
    content: Étendre AGENT_CONFIG dans src/orchestrator.ts (6 rôles + modèles)
    status: completed
  - id: npm-scripts
    content: Ajouter agent:devops, sre, release, ui, techwriter, privacy dans package.json
    status: completed
  - id: docs
    content: Mettre à jour README.md et CLAUDE.md (liste agents + précision pipeline + chaîne assurance / checklist infra)
    status: completed
  - id: tsc
    content: Valider avec npx tsc --noEmit
    status: completed
isProject: false
---

# Intégration des 6 agents sans régression

## Contexte technique

- Les prompts sont chargés par [`loadPrompt`](src/orchestrator.ts) depuis `src/prompts/<promptFile>.md`.
- Le contexte projet est déjà injecté **au début** du message dans [`runAgent`](src/orchestrator.ts) (`projectSection` puis `roleAndTask`), ce qui est aligné avec ce que décrivent tes nouveaux prompts et avec [`product-manager.md`](src/prompts/product-manager.md).
- [`AGENT_CONFIG`](src/orchestrator.ts) définit les clés CLI (`AgentRole`), le fichier prompt et le modèle. Le menu d’aide et la validation `--role` sont dérivés de cet objet.
- Le pipeline [`fullPipeline`](src/orchestrator.ts) (étapes 1–5, boucles QA / Red Team, `detectQAVerdict` / `detectSecurityVerdict`) **ne doit pas être modifié** pour garantir zéro régression sur le flux PM → Architect → Dev ⇄ QA ⇄ Red Team (conforme à [CLAUDE.md](CLAUDE.md)).

Le parallèle existant : le rôle `ux` est dans `AGENT_CONFIG` mais **n’est pas** invoqué par `fullPipeline` — les nouveaux rôles suivront le même mode **invocation manuelle** (`npm run agent:<nom>` ou `tsx ... --role <clé>`).

## Fichiers prompts à créer

Créer les six fichiers sous [`src/prompts/`](src/prompts/) avec le contenu que tu as fourni (noms de fichier exacts) :

| Fichier | Rôle orchestrateur proposé |
|---------|----------------------------|
| [`src/prompts/devops-platform.md`](src/prompts/devops-platform.md) | `devops` |
| [`src/prompts/sre-observability.md`](src/prompts/sre-observability.md) | `sre` |
| [`src/prompts/release-manager.md`](src/prompts/release-manager.md) | `release` |
| [`src/prompts/ui-designer.md`](src/prompts/ui-designer.md) | `ui` |
| [`src/prompts/technical-writer.md`](src/prompts/technical-writer.md) | `techwriter` |
| [`src/prompts/privacy-by-design.md`](src/prompts/privacy-by-design.md) | `privacy` |

**Collision UX / UI** : le rôle existant `ux` pointe vers `ux-designer` ; le nouveau rôle `ui` pointe vers `ui-designer` — pas de conflit de fichiers.

**Cohérence optionnelle** : pour être au même niveau que le PM, tu peux ajouter une phrase dans chaque nouveau prompt du type « le bloc **Contexte du projet cible** arrive au début du message, puis ton rôle, puis la tâche » (déjà présent implicitement dans tes textes pour plusieurs rôles). Ce n’est pas obligatoire pour le fonctionnement.

**Petites corrections de forme** (au collage) : dans `sre-observability.md`, « Tu reste » → « Tu restes » ; dans `technical-writer.md`, idem si présent.

## Modifications dans [`src/orchestrator.ts`](src/orchestrator.ts)

Étendre `AGENT_CONFIG` avec six entrées, en réutilisant la même convention de modèles que le reste :

- `MODEL_STRONG` pour les rôles où le raisonnement / la conformité pèsent lourd : **`devops`**, **`sre`**, **`privacy`** (aligné architect / redteam).
- `MODEL_FAST` pour **`release`**, **`techwriter`**, **`ui`** (aligné ux / dev / qa).

Descriptions courtes en français cohérentes avec les `description` existantes.

Aucune autre modification obligatoire dans ce fichier (pas de changement de `fullPipeline`, pas de nouveau type ou branchement).

## [`package.json`](package.json)

Ajouter des scripts miroir des existants, par exemple :

- `agent:devops`, `agent:sre`, `agent:release`, `agent:ui`, `agent:techwriter`, `agent:privacy`

Chaque script : `tsx src/orchestrator.ts --role <clé>`.

## Documentation

- [`README.md`](README.md) : mettre à jour le schéma « Architecture » et la liste des fichiers sous `src/prompts/` pour inclure les six agents ; préciser qu’ils se lancent **à la demande** (pas dans le pipeline par défaut) ; résumer ou renvoyer la **checklist Chaîne assurance** (section ci-dessous).
- [`CLAUDE.md`](CLAUDE.md) : compléter la section Structure / règles pour lister les nouveaux prompts et rappeler que le pipeline par défaut reste inchangé ; rappeler que les sorties **DevOps / SRE** hors `fullPipeline` exigent une **révision assurance** avant merge dans le repo cible.

## Sécurité / Chaîne assurance

**Contexte.** Les nouveaux rôles sont invoqués **manuellement**, comme `ux`. Le flux `fullPipeline` (PM → … → QA ⇄ Red Team) ne couvre donc pas automatiquement les **artefacts CI/CD, Docker ou observabilité** produits par `devops` / `sre`. Sans contrepartie, le risque est une **cassure de la chaîne assurance** (workflows permissifs, secrets statiques, images non épinglées, observabilité qui logue trop de données, etc.).

**Avant de merger** tout changement issu ou suggéré par ces agents sur le dépôt cible, traiter au moins l’une des options suivantes (cumulables) :

| Action | Détail |
|--------|--------|
| **Revue avec critères sécu** | Un humain vérifie le diff sous `.github/workflows/`, `Dockerfile*`, Compose, manifests K8s/Helm, définitions observabilité (alert rules, exporters), selon une courte liste ci-dessous. |
| **Passage agent Red Team ciblé** | Tâche dédiée : uniquement le diff **infra / CI / config déploiement** (sans remplacer la review humaine pour les environnements sensibles). |
| **Protections branches** | Exiger review + CI verte sur tout PR qui touche ces chemins lorsque GitHub/GitLab le permet. |

**Checklist minimale sur les workflows et conteneurs (à refléter en doc utilisateur)**

- Préférer **OIDC / identités fédérées** aux **secrets long-lived** dans les pipelines quand la plateforme le permet ; portée **minimal** des permissions (`GITHUB_TOKEN` et rôles cloud).
- **`permissions:`** sur le job aussi restreints que nécessaire ; éviter patterns dangereux non maîtrisés (`pull_request_target` depuis forks, exécution de code non éprouvé sur secrets).
- **Épinglage** des actions tierces (**SHA du commit**) ou versioning verrouillé ; images de base Docker **digest** ou tags explicites, rebuild reproductible.
- Pas de secrets en clair dans le repo ; exemples dans la doc avec **placeholders** clairement fictifs (« ne pas réutiliser en prod » dans les guides `techwriter`).
- **Dockerfile** : utilisateur non-root lorsque pertinent, pas de données sensibles en layer, HEALTHCHECK si le projet l’anticipe.

**Documentation produit.** Lors des mises à jour README / guides, éviter d’exposer détails internes inutiles (MCP internes, stratégie d’infra sensible) hors besoin légitime des contributeurs.

**Évolution prévue.** Un futur **`--pipeline extended`** (ou équivalent décrit hors du plan actuel) pourra ajouter **une ou plusieurs étapes optionnelles** (ex. Red Team sur infra, validation release) **sans modifier** le comportement du `full` existant ; ce plan ne l’implémente pas pour limiter régressions et durée des runs.

## Vérification

- Exécuter `npx tsc --noEmit` (exigence du repo).

## Hors périmètre (évite régression + explosion de durée)

- **Ne pas** enchaîner automatiquement DevOps / SRE / Release / UI / Tech writer / Privacy dans `fullPipeline` sans décision produit explicite (allongerait les runs, nouveaux checkpoints, interactions avec cloud/PR).
- Si tu veux plus tard un « pipeline étendu », traiter ça comme une évolution séparée (ex. flag `--pipeline extended` ou étapes optionnelles), sans toucher au `full` actuel — voir aussi **Sécurité / Chaîne assurance** pour le rôle de ce flag vis-a-vis de la révision infra avant merge.
