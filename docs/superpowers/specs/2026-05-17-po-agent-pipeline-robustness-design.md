# Design — Agent PO + pipeline backlog révisé + robustesse parsing

**Date :** 2026-05-17  
**Scope :** `src/backlog.ts`, `src/agent-config.ts`, `src/orchestrator/pipeline-backlog.ts`, `src/prompts/product-owner.md`, `CLAUDE.md`  
**Pipeline next :** inchangé

---

## 1. Robustesse parsing PM (3 correctifs)

### 1.1 Extraction de titre supplémentaire (backlog.ts)

**Problème :** `parsePMOutput` tombe en `"Issue sans titre"` silencieusement quand aucune des 4 stratégies actuelles ne trouve de titre.

**Correctif :** Avant le fallback, ajouter une 5ème tentative : prendre la première ligne heading `##` / `###` du bloc qui n'est **pas** un en-tête de section connue.

Sections connues à ignorer (insensible casse) :
```
User Story | Critères d'acceptation | Priorité | Scope technique | Risques | Taille
```

Si un heading non-section est trouvé → l'utiliser comme titre, strippé des `#` et emojis de début.

### 1.2 Warning visible post-parse

Si `title === "Issue sans titre"` après toutes les tentatives :
- `console.warn` avec aperçu des 100 premiers caractères du bloc (espaces normalisés)
- Le fallback est conservé pour que le parse ne bloque pas

Après `saveBacklog`, compter les issues à titre générique dans le batch :
```
⚠️  1 issue(s) sans titre dans ce run — vérifier le format de sortie PM/PO.
```

### 1.3 Cohérence issueCount sprint

`updateSprintIssueCount` est déjà appelé avec `parsedIssues.length` (compte réel persisté).  
Ajouter dans le log de fin :
```
✅ Backlog mis à jour via pipeline backlog forward (12 item(s) traités, dont 1 sans titre).
```

Cela rend le compte réel toujours visible sans nécessiter de lire le JSON.

---

## 2. Nouvel agent Product Owner (PO)

### 2.1 Rôle et distinction PM/PO

| Agent | Responsabilité |
|-------|---------------|
| **PO** (Product Owner) | Vision produit, priorisation business (MUST/SHOULD/COULD), critères d'acceptation métier, signal INCLUDE_UX_UI |
| **PM** (Product Manager) | Orchestration du backlog, cohérence transverse, format final (user stories structurées) |

Le PO produit une vision **métier** non encore formatée en user stories standard. Le PM transforme toutes les perspectives (PO + Architect + UX/UI optionnel + Red Team) en backlog final structuré.

### 2.2 Fichier prompt — `src/prompts/product-owner.md`

Le prompt PO doit :
- Analyser le repo et le brief pour identifier les besoins utilisateurs et business
- Prioriser en MUST / SHOULD / COULD avec justification business (pas technique)
- Lister les critères d'acceptation du point de vue utilisateur/métier
- Évaluer si le sprint nécessite un travail UX/UI (parcours utilisateur, interfaces, composants visuels)
- Terminer sa sortie par une ligne structurée : `INCLUDE_UX_UI: true` ou `INCLUDE_UX_UI: false`

### 2.3 Ajout dans `agent-config.ts`

```typescript
po: {
  promptFile: "product-owner",
  description: "Product Owner — vision métier & priorisation",
  tier: "strong" as const,
  defaultModel: {
    id: "claude-sonnet-4-5",
    params: [
      { id: "thinking", value: "true" },
      { id: "context",  value: "200k" },
      { id: "effort",   value: "medium" },
    ],
  } satisfies ModelSelection,
},
```

Variable d'environnement : `MODEL_PO`.

**Non inclus dans `PIPELINE_ROLE_WITH_SIZE_GRID`** : le PO s'exécute dans le pipeline backlog qui n'a pas d'issue size. La grille S/M/L/XL reste inchangée pour `pipeline next`.

---

## 3. Pipeline backlog révisé

### 3.1 Nouveau flux

```
PO (vision + priorisation + INCLUDE_UX_UI)
  ↓
Promise.all([
  Architect (architecture & contraintes techniques),
  UX (parcours utilisateur)   ← si INCLUDE_UX_UI: true
  UI (composants visuels)     ← si INCLUDE_UX_UI: true
])
  ↓
Red Team (challenge cohérence produit/architecture/UX)
  ↓
PM (synthèse finale → backlog formaté avec ## 🎯 User Story…)
```

### 3.2 Signal INCLUDE_UX_UI

Parsing par regex sur la sortie PO :
```typescript
const includeUxUi = /INCLUDE_UX_UI:\s*true/i.test(poOutput);
```

Si le tag est absent ou mal formé → défaut `false` + `console.warn`.

### 3.3 Passe parallèle — comportement

- `Promise.all` sur Architect + (UX et UI conditionnels)
- Si UX ou UI retourne une sortie vide (agent cloud échoué) → **non-bloquant** : on continue avec les sorties disponibles + `console.warn("UX/UI agent — sortie vide ignorée")`
- L'Architect est toujours présent (non conditionnel)

### 3.4 Contexte passé à chaque agent parallèle

Tous reçoivent : snapshot code + sortie PO.  
Red Team reçoit : snapshot + sortie PO + architecture + (UX si présent) + (UI si présent).  
PM synthèse reçoit : tout ce que Red Team a reçu + sortie Red Team.

### 3.5 Modifications dans `pipeline-backlog.ts`

Remplacer le premier `runAgent(session, "pm", pmTask, ...)` par `runAgent(session, "po", poTask, ...)`.  
Parser `INCLUDE_UX_UI` depuis `poOutput`.  
Construire le tableau de tâches parallèles et les résoudre avec `Promise.all`.  
Passer les sorties UX/UI (si présentes) au Red Team et au PM synthèse.  
Conserver `collectOpenAnswers` sur la sortie PO (comme sur la sortie PM actuelle).

### 3.6 `extractHandoffSection` — sections ciblées

- Architecture → `## Handoff Dev — Architecture` (inchangé)  
- Red Team → `## Handoff Dev — Produit` (inchangé)  
- UX/UI → non persistés dans `architectureVision` / `reflectionChallenge` ; passés uniquement comme contexte intermédiaire

---

## 4. Fichiers touchés — récapitulatif

| Fichier | Nature |
|---------|--------|
| `src/prompts/product-owner.md` | **Créé** |
| `src/agent-config.ts` | Ajout `po` dans `AGENT_DEFINITIONS` et `PER_ROLE_ENV_KEY` |
| `src/orchestrator/pipeline-backlog.ts` | Logique `pipelineBacklogReflection` révisée |
| `src/backlog.ts` | 3 correctifs parsing (titre, warning, log compte) |
| `CLAUDE.md` | Tableau agents (`po → product-owner`), description flux backlog |
| `src/orchestrator/cli.ts` | `--role po` disponible comme invocation manuelle |

**Inchangé :** `pipeline-next.ts`, `models.ts`, `pipeline-execution-run.ts`, grille S/M/L/XL.

---

## 5. Tests

- `src/backlog.test.ts` — cas "bloc sans h1 ni user story pattern" → vérifier warning + titre générique
- `src/orchestrator/pipeline-backlog` — pas de tests d'intégration directs (agents Cursor) ; valider via `npx tsc --noEmit`
- `npm run verify:prompts` — doit passer avec le nouveau `product-owner.md`

---

## 6. Non-scope (explicitement exclu)

- Grille S/M/L/XL pour le PO
- Modification de `pipeline next` (exécution ticket inchangée)
- Persistance des sorties UX/UI dans `backlog.json` (`architectureVision` / `reflectionChallenge` restent Architect + Red Team)
- Nouveaux types dans `models.ts`
