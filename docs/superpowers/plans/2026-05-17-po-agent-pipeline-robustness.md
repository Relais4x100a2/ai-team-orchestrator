# PO Agent + Pipeline Backlog Révisé + Robustesse Parsing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un agent Product Owner (PO) qui remplace le premier appel PM dans le pipeline backlog, lancer UX/UI en parallèle avec Architect quand le PO le signale, et corriger les bugs silencieux de parsing (titre manquant, regex `afin d'` / `qu'`).

**Architecture:** `parsePMOutput` reçoit 2 correctifs regex + 1 stratégie de fallback heading supplémentaire. Le pipeline backlog passe de `PM → Architect → Red Team → PM` à `PO → Promise.all([Architect, ?UX, ?UI]) → Red Team → PM`. L'agent PO est configuré comme `po` dans `AGENT_DEFINITIONS` avec `MODEL_PO` env et `product-owner.md` comme prompt.

**Tech Stack:** TypeScript/Node.js, tests natifs `node:test`, `npx tsc --noEmit` pour validation.

---

## Fichiers modifiés / créés

| Fichier | Action |
|---------|--------|
| `src/backlog.ts` | Correctifs regex stratégies 2 & 3 + stratégie 5 (heading) + warning |
| `src/agent-config.ts` | Ajout `po` dans `AGENT_DEFINITIONS` + `PER_ROLE_ENV_KEY` |
| `src/orchestrator/run-context.ts` | Ajout `po: "po.md"` dans `ROLE_OUTPUT_FILE` |
| `src/orchestrator/agent-runner.ts` | Ajout `"po"` dans `ROLES_REQUIRING_NON_EMPTY_OUTPUT` |
| `src/prompts/product-owner.md` | **Créé** |
| `src/orchestrator/pipeline-backlog.ts` | Logique `pipelineBacklogReflection` révisée + log final |
| `CLAUDE.md` | Tableau agents + description flux backlog |

---

## Task 1 — Correctifs parsing `src/backlog.ts`

**Files:**
- Modify: `src/backlog.ts:69-113`
- Test: `src/backlog.test.ts`

### Contexte des bugs

Trois bugs identifiés dans `parsePMOutput` :

1. **Stratégie 2** (`je veux … afin de`) : le pattern `(?:afin|pour)\s+de` ne matche pas `afin d'` (forme contractée française). Issue-003 en est victime : `je veux une synthèse… afin d'éviter` → titre non extrait.

2. **Stratégie 3** (`En tant que`) : le pattern `que\s+` ne matche pas `qu'` (apostrophe typographique). `En tant qu'utilisateur,` échoue.

3. **Stratégie manquante** : aucune tentative ne récupère le premier heading `##`/`###` qui n'est pas une section structurelle connue.

- [ ] **Step 1 : Écrire les tests qui échouent**

Dans `src/backlog.test.ts`, ajouter à la fin du bloc `describe("parsePMOutput")` existant :

```typescript
  it("extrait le titre avec 'afin d'' (apostrophe contractée)", () => {
    const pm = `## 🎯 User Story

En tant qu'utilisateur, je veux une synthèse stylométrique afin d'éviter une régression.

## 🏷️ Priorité

SHOULD

## 📏 Taille estimée

M
`;
    const issues = parsePMOutput(pm);
    assert.strictEqual(issues.length, 1);
    assert.ok(
      issues[0]!.title.includes("synthèse stylométrique"),
      `Titre attendu : contient "synthèse stylométrique", obtenu : "${issues[0]!.title}"`,
    );
  });

  it("extrait le titre avec 'En tant qu'' (apostrophe)", () => {
    const pm = `## 🎯 User Story

En tant qu'admin, je veux gérer les utilisateurs afin de contrôler les accès.

## 🏷️ Priorité

MUST

## 📏 Taille estimée

L
`;
    const issues = parsePMOutput(pm);
    assert.strictEqual(issues.length, 1);
    assert.ok(
      issues[0]!.title.includes("gérer les utilisateurs"),
      `Titre attendu : contient "gérer les utilisateurs", obtenu : "${issues[0]!.title}"`,
    );
  });

  it("extrait le titre depuis un heading ## non-section si h1 et user story patterns absents", () => {
    const pm = `## 🎯 User Story

Contenu sans pattern user story exploitable pour le titre.

## Authentification SSO

## 🏷️ Priorité

MUST

## 📏 Taille estimée

M
`;
    const issues = parsePMOutput(pm);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]!.title, "Authentification SSO");
  });

  it("retourne 'Issue sans titre' si aucune stratégie ne trouve un titre", () => {
    const pm = `## 🎯 User Story

Contenu quelconque sans pattern exploitable pour le titre.

## 🏷️ Priorité

COULD

## 📏 Taille estimée

S
`;
    const issues = parsePMOutput(pm);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]!.title, "Issue sans titre");
  });
```

- [ ] **Step 2 : Vérifier que les nouveaux tests échouent**

```bash
cd /home/guillaumecayeux/code_dev/ai-team-orchestrator && npm test 2>&1 | grep -A3 "afin d'\|tant qu'\|heading\|sans titre" | head -40
```

Expected: Les 2 premiers tests échouent (titre manquant pour `afin d'` et `qu'`). Le 3ème et 4ème peuvent passer ou échouer — peu importe à ce stade.

- [ ] **Step 3 : Corriger `parsePMOutput` dans `src/backlog.ts`**

Remplacer les lignes 81–96 (du bloc `for (const block of blocks)`) :

```typescript
    const h1Match = block.match(/^#\s+(.+?)$/m);
    let title = h1Match ? h1Match[1].trim() : null;

    if (!title) {
      const userStoryMatch = block.match(/je\s+veux\s+(.+?)\s+(?:afin|pour)\s+de/is);
      title = userStoryMatch ? userStoryMatch[1].trim().split("\n")[0] : null;
    }

    if (!title) {
      const enTantMatch = block.match(/\bEn\s+tant\s+que\s+[^,\n]+,\s*je\s+veux\s+(.+?)(?:\.|$)/is);
      title = enTantMatch ? enTantMatch[1].trim().split("\n")[0] : null;
    }

    if (!title) {
      const asAMatch = block.match(/\bas\s+a\s+[^,\n]+,\s*i\s+(?:want|need)\s+(.+?)(?:\.|,|$)/is);
      title = asAMatch ? asAMatch[1].trim().split("\n")[0] : null;
    }

    title = title || "Issue sans titre";
```

par :

```typescript
    const h1Match = block.match(/^#\s+(.+?)$/m);
    let title = h1Match ? h1Match[1].trim() : null;

    if (!title) {
      // Gère les formes contractées : "afin d'" en plus de "afin de" / "pour de"
      const userStoryMatch = block.match(/je\s+veux\s+(.+?)\s+(?:afin|pour)\s+(?:de|d')/is);
      title = userStoryMatch ? userStoryMatch[1].trim().split("\n")[0] : null;
    }

    if (!title) {
      // Gère "En tant qu'" (apostrophe) en plus de "En tant que " (espace)
      const enTantMatch = block.match(/\bEn\s+tant\s+qu[e']\s*[^,\n]+,\s*je\s+veux\s+(.+?)(?:\.|$)/is);
      title = enTantMatch ? enTantMatch[1].trim().split("\n")[0] : null;
    }

    if (!title) {
      const asAMatch = block.match(/\bas\s+a\s+[^,\n]+,\s*i\s+(?:want|need)\s+(.+?)(?:\.|,|$)/is);
      title = asAMatch ? asAMatch[1].trim().split("\n")[0] : null;
    }

    if (!title) {
      // 5ème tentative : premier heading ## ou ### qui n'est pas une section structurelle connue
      const KNOWN_SECTION_RE =
        /^#{2,3}\s*(?:🎯|📋|🏷️|📐|⚠️|📏)?\s*(?:User\s+Stor(?:y|ies)|Crit[eè]res?|Priorit[eé]|Scope|Risques?|Taille)/i;
      const altHeading = block
        .split("\n")
        .find((l) => /^#{2,3}\s+/.test(l) && !KNOWN_SECTION_RE.test(l));
      if (altHeading) {
        const candidate = altHeading.replace(/^#{2,3}\s+/, "").trim();
        if (candidate) title = candidate;
      }
    }

    if (!title) {
      const preview = block.slice(0, 100).replace(/\n/g, " ");
      console.warn(`   ⚠️  Titre non extrait pour un bloc PM/PO — aperçu : ${preview}`);
    }
    title = title || "Issue sans titre";
```

- [ ] **Step 4 : Vérifier que tous les tests passent**

```bash
npm test 2>&1 | tail -20
```

Expected:
```
✓ parsePMOutput > extrait une issue avec titre h1, priorité et taille
✓ parsePMOutput > extrait le titre avec 'afin d'' (apostrophe contractée)
✓ parsePMOutput > extrait le titre avec 'En tant qu'' (apostrophe)
✓ parsePMOutput > extrait le titre depuis un heading ## non-section si h1 et user story patterns absents
✓ parsePMOutput > retourne 'Issue sans titre' si aucune stratégie ne trouve un titre
... (tous les tests passent)
```

- [ ] **Step 5 : Vérification TypeScript**

```bash
npx tsc --noEmit 2>&1
```

Expected: aucune erreur.

- [ ] **Step 6 : Commit**

```bash
git add src/backlog.ts src/backlog.test.ts
git commit -m "$(cat <<'EOF'
fix: robustesse parsing PM/PO — afin d', qu', heading non-section

- Stratégie 2 : afin de|d' (forme contractée française)
- Stratégie 3 : En tant qu'|que (apostrophe)
- Stratégie 5 : premier heading ## non-section comme fallback titre
- Warning console.warn avant le fallback "Issue sans titre"

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Configuration agent PO

**Files:**
- Modify: `src/agent-config.ts`
- Modify: `src/orchestrator/run-context.ts:10-24`
- Modify: `src/orchestrator/agent-runner.ts:27`
- Create: `src/prompts/product-owner.md`

- [ ] **Step 1 : Ajouter `po` dans `AGENT_DEFINITIONS` (`src/agent-config.ts`)**

Après la ligne `const AGENT_DEFINITIONS = {` et avant `// ── Pipeline ──`, ajouter l'entrée `po` comme premier agent pipeline :

```typescript
const AGENT_DEFINITIONS = {
  // ── Pipeline ─────────────────────────────────────────────────────────────
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
  pm: {
```

- [ ] **Step 2 : Ajouter `MODEL_PO` dans `PER_ROLE_ENV_KEY` (`src/agent-config.ts`)**

Dans `PER_ROLE_ENV_KEY`, ajouter en premier :

```typescript
const PER_ROLE_ENV_KEY: Record<AgentRole, string> = {
  po: "MODEL_PO",
  pm: "MODEL_PM",
  architect: "MODEL_ARCHITECT",
  // ... reste inchangé
```

- [ ] **Step 3 : Ajouter `po: "po.md"` dans `ROLE_OUTPUT_FILE` (`src/orchestrator/run-context.ts`)**

Remplacer le bloc existant `ROLE_OUTPUT_FILE`:

```typescript
export const ROLE_OUTPUT_FILE: Record<AgentRole, string> = {
  po: "po.md",
  pm: "pm.md",
  architect: "architect.md",
  redteam_reflection: "redteam_reflection.md",
  dev: "dev.md",
  security: "security.md",
  qa: "qa.md",
  ux: "ux.md",
  ui: "ui.md",
  devops: "devops.md",
  sre: "sre.md",
  release: "release.md",
  techwriter: "techwriter.md",
  privacy: "privacy.md",
};
```

- [ ] **Step 4 : Ajouter `"po"` dans `ROLES_REQUIRING_NON_EMPTY_OUTPUT` (`src/orchestrator/agent-runner.ts`)**

Ligne 27, remplacer :

```typescript
const ROLES_REQUIRING_NON_EMPTY_OUTPUT = new Set<AgentRole>(["pm", "architect", "redteam_reflection"]);
```

par :

```typescript
const ROLES_REQUIRING_NON_EMPTY_OUTPUT = new Set<AgentRole>(["po", "pm", "architect", "redteam_reflection"]);
```

- [ ] **Step 5 : Créer `src/prompts/product-owner.md`**

```markdown
# Agent : Product Owner

## Identité

Tu es le Product Owner de l'équipe. Tu représentes la valeur métier et les besoins des utilisateurs finaux.
Tu traduis un brief stratégique en vision produit claire, en priorisant selon l'impact business — pas la complexité technique.
Lorsqu'un fichier projet est chargé, la stack et les contraintes du dépôt cible figurent dans le bloc **Contexte du projet cible**, **au début du message qui t'est transmis**, puis viennent les instructions de ton rôle et le texte de la tâche.

## Tes responsabilités

1. **Analyser le brief et le repo** pour identifier les besoins utilisateurs et business réels (pas seulement ceux explicitement formulés)
2. **Prioriser** en MUST / SHOULD / COULD avec justification métier : bénéfice utilisateur, risque produit, valeur business — jamais la complexité technique comme critère de priorité
3. **Définir les critères d'acceptation** du point de vue utilisateur et métier : comportements observables, règles business, invariants — pas des critères d'implémentation
4. **Évaluer** si le sprint nécessite un travail UX/UI : parcours utilisateur nouveau ou modifié, interfaces graphiques, formulaires, composants visuels, écrans, navigation

## Format de sortie attendu

Produis une **liste de besoins priorisés** (le PM produira ensuite les user stories formatées). Pour chaque besoin :

```markdown
### [Titre court du besoin]

**Priorité :** MUST | SHOULD | COULD

**Valeur métier :** [Pourquoi c'est important pour l'utilisateur ou le produit — 1-2 phrases]

**Critères d'acceptation métier :**
- [ ] [Comportement observable ou règle business]
- [ ] [Comportement observable ou règle business]

**Hypothèses :** [Hypothèses ou contraintes identifiées côté métier]
```

Sépare chaque besoin par `---`.

## Signal UX/UI (OBLIGATOIRE — dernière ligne de ta sortie)

Termine **toujours** ta sortie par une évaluation explicite du besoin en UX/UI.

Si le sprint implique de nouvelles interfaces graphiques, des modifications de parcours utilisateur, des formulaires, des composants visuels, des écrans, de la navigation, ou toute interaction utilisateur substantielle :

```
INCLUDE_UX_UI: true
```

Si le sprint est orienté back-end, infrastructure, API, scripts, ou si les interfaces concernées sont purement internes sans changement UX perceptible pour l'utilisateur final :

```
INCLUDE_UX_UI: false
```

**Cette ligne est obligatoire.** Ne l'omets pas.

## Règles

- Tu ne spécifies pas l'architecture technique. Tu décris CE QUE doit faire le système, pas COMMENT.
- Tu interroges le brief et le repo pour détecter les besoins implicites non formulés.
- Tu distingues ce qui est critique pour la valeur utilisateur (MUST) de ce qui améliore le confort (SHOULD) ou est souhaitable sans urgence (COULD).
- Tu poses des questions structurées si le brief est trop ambigu pour prioriser (format `[QUESTION] …`).
- Si `local_path` est disponible, explore la structure du code avant de produire ta réponse.
```

- [ ] **Step 6 : Vérifier les prompts et le typage**

```bash
npm run verify:prompts 2>&1
npx tsc --noEmit 2>&1
```

Expected: aucune erreur. Si `verify:prompts` signale un fichier manquant, vérifier que `src/prompts/product-owner.md` a bien été créé.

- [ ] **Step 7 : Commit**

```bash
git add src/agent-config.ts src/orchestrator/run-context.ts src/orchestrator/agent-runner.ts src/prompts/product-owner.md
git commit -m "$(cat <<'EOF'
feat: agent PO (Product Owner) — config + prompt product-owner.md

- AGENT_DEFINITIONS: po → product-owner.md (sonnet, thinking:true)
- PER_ROLE_ENV_KEY: MODEL_PO
- ROLE_OUTPUT_FILE: po.md
- ROLES_REQUIRING_NON_EMPTY_OUTPUT: inclut po
- Prompt : vision métier, priorisation MUST/SHOULD/COULD, signal INCLUDE_UX_UI

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Pipeline backlog révisé (`pipeline-backlog.ts`)

**Files:**
- Modify: `src/orchestrator/pipeline-backlog.ts:136-289`

Cette tâche remplace l'intégralité du corps de `pipelineBacklogReflection` à partir de `const frugal = ...` (ligne 178).

- [ ] **Step 1 : Lire la fonction actuelle pour avoir les numéros de ligne exacts**

```bash
grep -n "const frugal\|const codeSnapshot\|const withSnapshot\|const pmTask\|const specs\b\|const pmAnswers\|const architecture\b\|const archAnswers\|const reflection\b\|const reflectionAnswers\|const pmSynthesisTask\|const specsFinal\|parsedIssues\|saveBacklog\|updateSprintIssueCount\|console.log.*Backlog mis" /home/guillaumecayeux/code_dev/ai-team-orchestrator/src/orchestrator/pipeline-backlog.ts
```

- [ ] **Step 2 : Remplacer le corps de `pipelineBacklogReflection` à partir de `const frugal`**

Localiser la ligne `const frugal = await checkFrugalMode(process.env);` (ligne ~178) et remplacer tout ce qui suit jusqu'à la fin de la fonction (accolade fermante `}` finale) par :

```typescript
  const frugal = await checkFrugalMode(process.env);

  const codeSnapshot = session.activeProject?.localPath
    ? buildCodeSnapshot(session.activeProject.localPath, session.activeProject.projectDataDir ?? undefined)
    : "";

  const withSnapshot = (ctx: string, includeCarryover = false): string => {
    const parts: string[] = [];
    if (includeCarryover && backlogContext) parts.push(backlogContext);
    if (codeSnapshot) parts.push(`## Contexte code du projet\n\n${codeSnapshot}`);
    parts.push(ctx);
    return parts.join("\n\n---\n\n");
  };

  // ── Étape 1 : PO (vision métier + signal INCLUDE_UX_UI) ──────────────────
  const poTask =
    direction === "forward"
      ? "À partir de cette métavision, produis la vision métier et les besoins priorisés avec critères d'acceptation utilisateur. Évalue si le sprint nécessite un travail UX/UI."
      : "À partir de ce feedback terrain, identifie les ajustements de valeur métier et priorisation nécessaires. Évalue si le sprint nécessite un travail UX/UI.";
  const poOutput = await runAgent(session, "po", poTask, {
    additionalContext: withSnapshot(brief, true),
    frugal,
    cloud: resolveCloudMode(session, "po"),
  });

  const poAnswers = await collectOpenAnswers(poOutput);
  const poOutputWithAnswers = poAnswers ? `${poAnswers}\n\n---\n\n${poOutput}` : poOutput;

  // Parse du signal INCLUDE_UX_UI
  const includeUxUiMatch = /INCLUDE_UX_UI:\s*(true|false)/i.exec(poOutput);
  if (!includeUxUiMatch) {
    console.warn("   ⚠️  Signal INCLUDE_UX_UI absent de la sortie PO — UX/UI non invoqués par défaut.");
  }
  const includeUxUi = includeUxUiMatch?.[1]?.toLowerCase() === "true";
  console.log(`   🎨 UX/UI dans ce sprint : ${includeUxUi ? "oui" : "non"}`);

  // ── Étape 2 : Architect + UX/UI optionnels (parallèle) ───────────────────
  const parallelTasks: Promise<string>[] = [
    runArchitectForBacklogReflection(session, withSnapshot(poOutputWithAnswers), frugal),
  ];

  if (includeUxUi) {
    console.log("   🎨 Lancement UX + UI en parallèle avec Architect…");
    parallelTasks.push(
      runAgent(
        session,
        "ux",
        "À partir de la vision PO, propose les parcours utilisateur et wireframes clés pour ce sprint.",
        {
          additionalContext: withSnapshot(poOutputWithAnswers),
          frugal,
          cloud: resolveCloudMode(session, "ux"),
        },
      ),
      runAgent(
        session,
        "ui",
        "À partir de la vision PO, propose les composants visuels et tokens UI nécessaires pour ce sprint.",
        {
          additionalContext: withSnapshot(poOutputWithAnswers),
          frugal,
          cloud: resolveCloudMode(session, "ui"),
        },
      ),
    );
  }

  const parallelResults = await Promise.all(parallelTasks);
  const architecture = parallelResults[0]!;
  const uxOutput = includeUxUi ? (parallelResults[1] ?? "") : "";
  const uiOutput = includeUxUi ? (parallelResults[2] ?? "") : "";

  if (includeUxUi) {
    if (!uxOutput) console.warn("   ⚠️  Agent UX — sortie vide, ignorée.");
    if (!uiOutput) console.warn("   ⚠️  Agent UI — sortie vide, ignorée.");
  }

  const archAnswers = await collectOpenAnswers(architecture);
  const architectureWithAnswers = archAnswers ? `${archAnswers}\n\n---\n\n${architecture}` : architecture;

  // ── Étape 3 : Red Team ───────────────────────────────────────────────────
  const uxUiContext = [
    uxOutput ? `## Vision UX\n${uxOutput}` : "",
    uiOutput ? `## Vision UI\n${uiOutput}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const reflection = await runAgent(
    session,
    "redteam_reflection",
    "Challenge la cohérence produit/architecture et propose les ajustements backlog nécessaires.",
    {
      additionalContext: withSnapshot(
        `## Vision PO\n${poOutputWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}${uxUiContext ? `\n\n${uxUiContext}` : ""}`,
      ),
      frugal,
      cloud: resolveCloudMode(session, "redteam_reflection"),
    },
  );

  const reflectionAnswers = await collectOpenAnswers(reflection);
  const reflectionWithAnswers = reflectionAnswers ? `${reflectionAnswers}\n\n---\n\n${reflection}` : reflection;

  // ── Étape 4 : PM synthèse finale ─────────────────────────────────────────
  const pmSynthesisTask =
    "À partir de la vision PO, des contraintes architecture, des perspectives UX/UI et des défis red team, produis la version FINALE et révisée du backlog. Intègre les ajustements de priorité, taille et description proposés. Utilise EXACTEMENT le même format (## 🎯 User Story, ## 🏷️ Priorité, ## 📏 Taille estimée, etc.) séparé par ---.";
  const specsFinal = await runAgent(session, "pm", pmSynthesisTask, {
    additionalContext: withSnapshot(
      `## Vision PO\n${poOutputWithAnswers}\n\n## Vision architecture\n${architectureWithAnswers}${uxUiContext ? `\n\n${uxUiContext}` : ""}\n\n## Défis et ajustements Red Team\n${reflectionWithAnswers}`,
    ),
    frugal,
    cloud: resolveCloudMode(session, "pm"),
  });

  // ── Parse + persistance backlog ───────────────────────────────────────────
  const parsedIssues = parsePMOutput(specsFinal);
  if (parsedIssues.length === 0) {
    console.log("⚠️  Aucune issue parsée depuis la sortie PM (synthèse finale) — backlog non modifié.");
    savePmParseFailureArtifacts(session, specsFinal, {
      architecture: architectureWithAnswers,
      reflection: reflectionWithAnswers,
    });
    return;
  }

  const backlog = loadBacklog(session);
  const now = new Date().toISOString();
  const archSummaryExtract = extractHandoffSection(architecture, "## Handoff Dev — Architecture");
  warnIfHandoffFallback("Vision architecture (→ backlog.json)", architecture, "## Handoff Dev — Architecture", archSummaryExtract);
  const architectureSummary = archSummaryExtract || previewText(architecture, 500);

  const reflectionSummaryExtract = extractHandoffSection(reflection, "## Handoff Dev — Produit");
  warnIfHandoffFallback("Red team réflexion (→ backlog.json)", reflection, "## Handoff Dev — Produit", reflectionSummaryExtract);
  const reflectionSummary = reflectionSummaryExtract || previewText(reflection, 500);

  for (const parsed of parsedIssues) {
    const existing = backlog.issues.find((i) => i.title.trim().toLowerCase() === parsed.title.trim().toLowerCase());
    if (existing) {
      existing.description = parsed.description;
      existing.priority = parsed.priority;
      existing.size = parsed.size;
      existing.source = source;
      if (existing.priority === "MUST" || existing.priority === "SHOULD") {
        existing.architectureVision = architectureSummary;
        existing.reflectionChallenge = reflectionSummary;
      }
      existing.updatedAt = now;
      continue;
    }

    const id = generateIssueId(backlog);
    backlog.issues.push({
      ...parsed,
      id,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      pipelineRun: null,
      source,
      architectureVision:
        parsed.priority === "MUST" || parsed.priority === "SHOULD" ? architectureSummary : undefined,
      reflectionChallenge:
        parsed.priority === "MUST" || parsed.priority === "SHOULD" ? reflectionSummary : undefined,
    });
  }

  saveBacklog(session, backlog);
  if (session.activeProject?.projectDataDir && session.activeSprintId) {
    updateSprintIssueCount(session.activeProject.projectDataDir, session.activeSprintId, parsedIssues.length);
  }

  // Log final avec compte réel et nombre de titres manquants
  const untitled = parsedIssues.filter((i) => i.title === "Issue sans titre").length;
  const untitledNote = untitled > 0 ? `, dont ${untitled} sans titre` : "";
  console.log(
    `\n✅ Backlog mis à jour via pipeline backlog ${direction} (${parsedIssues.length} item(s) traités${untitledNote}).`,
  );
  if (untitled > 0) {
    console.warn(`   ⚠️  ${untitled} issue(s) sans titre dans ce run — vérifier le format de sortie PM/PO.`);
  }
  printBacklogSummary(session, backlog);
}
```

- [ ] **Step 3 : Vérifier le typage**

```bash
npx tsc --noEmit 2>&1
```

Expected: aucune erreur. Si des erreurs de type apparaissent sur `parallelResults[1]` ou `parallelResults[2]`, s'assurer que `parallelTasks` est typé `Promise<string>[]` (pas `Promise<string | undefined>[]`).

- [ ] **Step 4 : Lancer les tests**

```bash
npm test 2>&1 | tail -10
```

Expected: tous les tests passent.

- [ ] **Step 5 : Commit**

```bash
git add src/orchestrator/pipeline-backlog.ts
git commit -m "$(cat <<'EOF'
feat: pipeline backlog PO → Promise.all(Architect+UX+UI) → Red Team → PM

- Remplace le premier appel PM par l'agent PO (vision métier)
- Parse INCLUDE_UX_UI depuis la sortie PO
- Lance UX + UI en parallèle avec Architect si INCLUDE_UX_UI: true
- Red Team et PM synthèse reçoivent les sorties UX/UI si présentes
- Log final affiche le compte réel d'issues et le nombre sans titre

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Documentation `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1 : Mettre à jour le tableau des agents**

Dans `CLAUDE.md`, dans la section `## Agents : clés CLI (--role) ⇄ fichier prompt`, ajouter la ligne `po` en première position du tableau :

```markdown
| `po`       | `product-owner`                            |
| `pm`       | `product-manager`                          |
```

- [ ] **Step 2 : Mettre à jour la description du flux pipeline backlog**

Dans `CLAUDE.md`, dans le paragraphe qui décrit `--pipeline backlog`, remplacer la description du flux. Chercher la ligne contenant `PM + architecte + red team réflexion` et la remplacer par :

```
**Pipeline backlog (`--pipeline backlog` forward | backward) :** PO (vision métier + signal INCLUDE_UX_UI) → `Promise.all([Architect, ?UX, ?UI])` → Red Team réflexion → PM (synthèse finale). Les champs `architectureVision` et `reflectionChallenge` persistés dans `backlog.json` sur les issues MUST/SHOULD sont **une paire unique par run**, répliquée sur **tout le batch** d'issues — cadre transverse du run. UX et UI sont invoqués uniquement si le PO émet `INCLUDE_UX_UI: true` (sprint avec interfaces utilisateur).
```

- [ ] **Step 3 : Vérifier que `npm run verify:prompts` passe toujours**

```bash
npm run verify:prompts 2>&1
```

Expected: aucune erreur.

- [ ] **Step 4 : Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md — agent PO + flux pipeline backlog révisé

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Vérification finale

- [ ] **Step 1 : TypeScript complet**

```bash
npx tsc --noEmit 2>&1
```

Expected: `0` erreur.

- [ ] **Step 2 : Suite de tests complète**

```bash
npm test 2>&1
```

Expected: tous les tests passent, y compris les 4 nouveaux dans `parsePMOutput`.

- [ ] **Step 3 : Vérification prompts**

```bash
npm run verify:prompts 2>&1
```

Expected: `product-owner` listé et fichier trouvé.

- [ ] **Step 4 : Smoke check agent `po` disponible via CLI**

```bash
npm run start 2>&1 | grep -i "po\|product"
```

Expected: `po` apparaît dans la liste des rôles disponibles.

- [ ] **Step 5 : Vérifier git log**

```bash
git log --oneline -6
```

Expected:
```
<hash> docs: CLAUDE.md — agent PO + flux pipeline backlog révisé
<hash> feat: pipeline backlog PO → Promise.all(Architect+UX+UI) → Red Team → PM
<hash> feat: agent PO (Product Owner) — config + prompt product-owner.md
<hash> fix: robustesse parsing PM/PO — afin d', qu', heading non-section
<hash> docs: spec agent PO + pipeline backlog révisé + robustesse parsing
```
