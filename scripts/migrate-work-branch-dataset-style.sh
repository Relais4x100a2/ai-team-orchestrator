#!/usr/bin/env bash
# Migration : consolide les branches backlog/<ULID>-* de dataset_style
# vers la branche fixe ai-team/pipeline.
#
# Ce script est idempotent : relancez-le sans risque si interrompu.

set -euo pipefail

REPO_DIR="${HOME}/code_dev/dataset_style"
BASE_BRANCH="deploy-caprover-relais4"
FIXED_BRANCH="ai-team/pipeline"

cd "$REPO_DIR"

echo "=== Migration branche de travail dataset_style ==="
echo "Repo    : $REPO_DIR"
echo "Base    : $BASE_BRANCH"
echo "Cible   : $FIXED_BRANCH"
echo ""

# Vérifie qu'on est dans un dépôt Git
git rev-parse --is-inside-work-tree > /dev/null 2>&1 || { echo "❌ Pas un dépôt Git : $REPO_DIR"; exit 1; }

# Fetch pour avoir l'état remote à jour
echo "→ fetch origin..."
git fetch --prune origin

# Vérifie que la branche de base existe
git rev-parse --verify "origin/$BASE_BRANCH" > /dev/null 2>&1 || {
  echo "❌ Branche de base introuvable en remote : origin/$BASE_BRANCH"
  exit 1
}

# --- Créer ou retrouver la branche fixe ---
LOCAL_EXISTS=false
REMOTE_EXISTS=false
git rev-parse --verify "refs/heads/$FIXED_BRANCH" > /dev/null 2>&1 && LOCAL_EXISTS=true
git rev-parse --verify "refs/remotes/origin/$FIXED_BRANCH" > /dev/null 2>&1 && REMOTE_EXISTS=true

if $LOCAL_EXISTS; then
  echo "✅ Branche locale '$FIXED_BRANCH' déjà présente."
elif $REMOTE_EXISTS; then
  echo "→ Création locale depuis origin/$FIXED_BRANCH..."
  git checkout -b "$FIXED_BRANCH" --track "origin/$FIXED_BRANCH"
  LOCAL_EXISTS=true
else
  echo "→ Création de '$FIXED_BRANCH' depuis '$BASE_BRANCH'..."
  git checkout "$BASE_BRANCH"
  git pull --ff-only origin "$BASE_BRANCH" 2>/dev/null || true
  git checkout -b "$FIXED_BRANCH"
  echo "→ Push initial..."
  git push -u origin "$FIXED_BRANCH"
  LOCAL_EXISTS=true
fi

# --- Lister les branches backlog existantes ---
BACKLOG_BRANCHES=$(git branch --list "backlog/*" | sed 's/^[* ]*//')

if [ -z "$BACKLOG_BRANCHES" ]; then
  echo ""
  echo "ℹ️  Aucune branche backlog/* locale trouvée. Migration terminée."
else
  echo ""
  echo "Branches backlog/* existantes :"
  echo "$BACKLOG_BRANCHES" | sed 's/^/  - /'
  echo ""
  echo "Ces branches ne sont PAS fusionnées automatiquement (risque de conflits)."
  echo "Pour chaque branche à intégrer dans '$FIXED_BRANCH', faites :"
  echo ""
  echo "  git checkout $FIXED_BRANCH"
  echo "  git merge --no-ff <branche-backlog>  # ou : git cherry-pick <sha>"
  echo "  git push origin $FIXED_BRANCH"
  echo ""
  echo "Pour supprimer les branches locales backlog/* après intégration :"
  echo "  git branch -d \$(git branch --list 'backlog/*' | tr -d ' ')"
  echo ""
  echo "Pour supprimer les branches remote backlog/* après intégration :"
  echo "  git push origin --delete \$(git branch -r --list 'origin/backlog/*' | sed 's|origin/||' | tr -d ' ')"
fi

echo ""
git checkout "$FIXED_BRANCH"
echo "✅ Vous êtes maintenant sur '$FIXED_BRANCH'."
echo ""
echo "Les prochains 'pipeline next' utiliseront systématiquement cette branche."
