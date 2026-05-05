/**
 * Garde-fou budgétaire : décide si le mode frugal doit s'activer.
 *
 * Priorité de décision :
 * 1) FRUGAL_DEFAULT=true|false (override explicite)
 * 2) CURSOR_BILLING_MODE=solo -> frugal ON par défaut (sans API spend)
 * 3) CURSOR_BILLING_MODE=team -> seuil SPEND_ALERT_CENTS via API /teams/spend
 *
 * Team sans SPEND_ALERT_CENTS -> frugal OFF.
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

type BillingMode = "solo" | "team";

function parseBoolean(value: string | undefined): boolean | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null;
}

function resolveBillingMode(env: NodeJS.ProcessEnv): BillingMode {
  const raw = env.CURSOR_BILLING_MODE?.trim().toLowerCase();
  return raw === "team" ? "team" : "solo";
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
  const explicit = parseBoolean(env.FRUGAL_DEFAULT);
  if (explicit !== null) return explicit;

  const billingMode = resolveBillingMode(env);
  if (billingMode === "solo") return true;

  const alertCents = parseInt(env.SPEND_ALERT_CENTS ?? "", 10);
  if (!alertCents || isNaN(alertCents) || alertCents <= 0) return false;

  const apiKey = env.CURSOR_API_KEY;
  if (!apiKey) return false;

  const spentCents = await fetchSpendCents(apiKey, env.SPEND_CHECK_EMAIL);
  if (spentCents === null) return false; // fail-open

  return spentCents >= alertCents;
}
