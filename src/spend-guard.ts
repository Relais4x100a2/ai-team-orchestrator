/**
 * Garde-fou budgétaire : interroge l'API Admin Cursor pour détecter si le seuil
 * de dépenses est atteint et activer le mode frugal (composer-2 pour tous les agents).
 *
 * Activation : définir SPEND_ALERT_CENTS dans .env (ex: 5000 = $50).
 * Sans cette variable, la vérification est ignorée.
 */

interface TeamMemberSpend {
  userId: number;
  email: string;
  spendCents: number;
  overallSpendCents: number;
  monthlyLimitDollars: number | null;
}

interface SpendResponse {
  teamMemberSpend: TeamMemberSpend[];
}

/**
 * Récupère la dépense totale (overallSpendCents) pour le cycle en cours.
 * Si SPEND_CHECK_EMAIL est défini, ne regarde que cet utilisateur.
 * En cas d'erreur réseau, retourne null (fail-open : ne pas bloquer).
 */
export async function fetchSpendCents(
  apiKey: string,
  filterEmail?: string,
): Promise<number | null> {
  try {
    const body = filterEmail ? JSON.stringify({ searchTerm: filterEmail }) : "{}";
    const res = await fetch("https://api.cursor.com/teams/spend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      },
      body,
    });

    if (!res.ok) {
      console.warn(`⚠️  spend-guard : API responded ${res.status} — skipping check.`);
      return null;
    }

    const data = (await res.json()) as SpendResponse;
    if (!Array.isArray(data.teamMemberSpend)) return null;

    const members = filterEmail
      ? data.teamMemberSpend.filter(m =>
          m.email.toLowerCase() === filterEmail.toLowerCase(),
        )
      : data.teamMemberSpend;

    return members.reduce((sum, m) => sum + (m.overallSpendCents ?? 0), 0);
  } catch {
    console.warn("⚠️  spend-guard : impossible de contacter l'API — vérification ignorée.");
    return null;
  }
}

/**
 * Retourne true si le mode frugal doit s'activer.
 * Conditions :
 *   - SPEND_ALERT_CENTS est défini dans l'env
 *   - La dépense actuelle dépasse ce seuil
 */
export async function checkFrugalMode(env: NodeJS.ProcessEnv): Promise<boolean> {
  const alertCents = parseInt(env.SPEND_ALERT_CENTS ?? "", 10);
  if (!alertCents || isNaN(alertCents) || alertCents <= 0) return false;

  const apiKey = env.CURSOR_API_KEY;
  if (!apiKey) return false;

  const spentCents = await fetchSpendCents(apiKey, env.SPEND_CHECK_EMAIL);
  if (spentCents === null) return false; // fail-open

  return spentCents >= alertCents;
}
