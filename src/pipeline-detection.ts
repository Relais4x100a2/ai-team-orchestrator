/**
 * Heuristiques minimales pour interpréter les rapports QA / Sécurité dans le pipeline.
 *
 * Détection QA (bilingue) : ligne explicite `VERDICT: …`, bloc « ### … Verdict »,
 * puis motifs EN/FR dans le corps (hors blocs ```) — évite les faux positifs sur
 * citations/code, et sur les formulations négées via l’analyse préférentielle du bloc verdict.
 */

export type QAVerdict = "APPROVE" | "REQUEST_CHANGES";

export type SecurityVerdict = "APPROVED" | "CRITICAL_ISSUES" | "MEDIUM_ISSUES";

const VERDICT_LINE = /^\s*VERDICT\s*[:：]\s*(.+)$/gim;

/** Découpe Markdown (blocs ``` ... ```) pour le scan « corps complet » — évite les faux REQUEST_CHANGES dans citations / extraits de code. */
function stripMarkdownFencedCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ");
}

function normalizeAccents(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Retourne un verdict uniquement si la ligne dédiée est non ambiguë. */
function verdictFromDirectiveLine(qaReport: string): QAVerdict | null {
  VERDICT_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VERDICT_LINE.exec(qaReport)) !== null) {
    const token = normalizeAccents(m[1]!.trim().replace(/[`_*]/g, ""));
    if (token.includes("request_changes") || token.includes("request changes")) {
      return "REQUEST_CHANGES";
    }
    if (token.includes("approve") && !token.includes("comment")) {
      return "APPROVE";
    }
    if (
      token.includes("changement") &&
      (token.includes("requis") || token.includes("requise") || token.includes("necessaires"))
    ) {
      return "REQUEST_CHANGES";
    }
    if (token.includes("demander") && token.includes("changement")) {
      return "REQUEST_CHANGES";
    }
    if (token.includes("demande") && token.includes("changement")) {
      return "REQUEST_CHANGES";
    }
    if (
      token.startsWith("comment") ||
      (token.includes("comment") && !token.includes("changement"))
    ) {
      return "APPROVE";
    }
  }
  return null;
}

/** Contenu après un titre Markdown « ### … Verdict » jusqu’au prochain `###` ou fin. */
export function extractQAVerdictSection(qaReport: string): string | null {
  const match = qaReport.match(/^\s*(#{1,6})\s*(?:[^\n]*verdict[^\n]*)$/im);
  if (!match) return null;

  const start = match.index! + match[0].length;
  let rest = qaReport.slice(start);
  const nextSection = rest.search(/^\s*#{1,6}\s/m);
  const sectionBody = nextSection === -1 ? rest : rest.slice(0, nextSection);
  return sectionBody.trim() || null;
}

function containsRequestChangesHaystack(haystack: string): boolean {
  const n = normalizeAccents(haystack);

  if (n.includes("request_changes") || n.includes("request changes")) {
    return true;
  }

  const frClear = [
    "demander des changements",
    "demande des changements",
    "demande de changements",
  ];
  for (const p of frClear) {
    if (n.includes(normalizeAccents(p))) return true;
  }

  const mentionsRequiredChanges =
    /\bchangements?\s+requis\b/.test(n) ||
    /\bmodifications\s+requises\b/.test(n) ||
    /\bcorrections\s+requises\b/.test(n);

  if (mentionsRequiredChanges) {
    const negated =
      /\bpas\s+d['’]?\s*changements?\s+requis\b/.test(n) ||
      /\b(?:pas\s+de|sans)\s+changements?\s+requis\b/.test(n) ||
      /\baucun\s+changement\s+requis\b/.test(n) ||
      /\bpas\s+d['’]?\s*modifications?\s+requises\b/.test(n) ||
      /\baucune\s+modifications?\s+requises\b/.test(n);

    return !negated;
  }

  return false;
}

/** Déduit si QA approuve ou demande des changements à partir du texte du rapport. */
export function detectQAVerdict(qaReport: string): QAVerdict {
  const fromLine = verdictFromDirectiveLine(qaReport);
  if (fromLine) return fromLine;

  const section = extractQAVerdictSection(qaReport);
  if (section && containsRequestChangesHaystack(stripMarkdownFencedCodeBlocks(section))) {
    return "REQUEST_CHANGES";
  }

  const body = qaReport.trim();
  const bodySansBlocsCode = stripMarkdownFencedCodeBlocks(body);
  if (
    /\b\[?\s*(?:REQUEST_CHANGES)\s*\]?\b/i.test(bodySansBlocsCode) ||
    /\*\*\s*(?:REQUEST_CHANGES|REQUEST CHANGES)\s*\*\*/i.test(bodySansBlocsCode)
  ) {
    return "REQUEST_CHANGES";
  }

  if (containsRequestChangesHaystack(bodySansBlocsCode)) {
    return "REQUEST_CHANGES";
  }

  return "APPROVE";
}

/** Déduit le niveau d’alerte sécurité à partir du texte du rapport Sécurité. */
export function detectSecurityVerdict(securityReport: string): SecurityVerdict {
  const lowerReport = securityReport.toLowerCase();
  if (
    lowerReport.includes("🚨 vulnérabilités critiques") ||
    lowerReport.includes("vulnérabilités critiques")
  ) {
    return "CRITICAL_ISSUES";
  }
  if (
    lowerReport.includes("⚠️ vulnérabilités moyennes") ||
    lowerReport.includes("vulnérabilités moyennes")
  ) {
    return "MEDIUM_ISSUES";
  }
  return "APPROVED";
}
