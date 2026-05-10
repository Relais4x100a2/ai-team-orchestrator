/**
 * Heuristiques minimales pour interpréter les rapports QA / Sécurité dans le pipeline.
 *
 * Détection QA : lignes `VERDICT QA:` / `VERDICT:` (la **dernière** occurrence l’emporte),
 * puis bloc « ### … Verdict » et motifs EN/FR dans le corps (hors blocs ```).
 *
 * Détection sécurité : ligne prioritaire `VERDICT SÉCURITÉ:` / `SECURITY_VERDICT:`,
 * puis sections « vulnérabilités critiques/moyennes » avec négations explicites
 * (ex. « Aucune identifiée », « Aucune critique nouvelle bloquante »).
 */

export type QAVerdict = "APPROVE" | "REQUEST_CHANGES";

export type SecurityVerdict = "APPROVED" | "CRITICAL_ISSUES" | "MEDIUM_ISSUES";

/** `VERDICT: …` ou `VERDICT QA: …` — dernière ligne interprétable gagne. */
const QA_VERDICT_DIRECTIVE =
  /^\s*VERDICT(?:\s+QA)?\s*[:：]\s*(.+)$/gim;

/** Ligne machine lisible en fin de rapport sécurité (prioritaire sur les heuristiques). */
const SECURITY_VERDICT_LINE =
  /^\s*(?:VERDICT\s*S[ÉE]CURIT[ÉE]|SECURITY_VERDICT|SECURITY\s+VERDICT)\s*[:：]\s*(.+)$/gim;

/** Découpe Markdown (blocs ``` ... ```) pour le scan « corps complet » — évite les faux REQUEST_CHANGES dans citations / extraits de code. */
function stripMarkdownFencedCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ");
}

function normalizeAccents(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function mapQAVerdictFromDirectiveValue(raw: string): QAVerdict | null {
  /** Ne pas retirer `_` : les directives GitHub (`REQUEST_CHANGES`) perdent le séparateur et ne matchent plus. */
  const token = normalizeAccents(raw.trim().replace(/[`*]/g, "")).replace(/\s+/g, " ");
  if (!token) return null;
  if (
    /\bnon\s+approuve\b/.test(token) ||
    /\bpas\s+approuve\b/.test(token) ||
    /\bnot\s+approved\b/.test(token) ||
    /\brefus\b/.test(token)
  ) {
    return null;
  }

  if (token.includes("request_changes") || token.includes("request changes")) {
    return "REQUEST_CHANGES";
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

  if ((/\bapprove\b/.test(token) || /\bapprouve\b/.test(token)) && !token.includes("comment")) {
    return "APPROVE";
  }
  if (token === "lgtm" || /^lgtm\b/.test(token)) {
    return "APPROVE";
  }
  if (/\bok\s+pour\s+merge\b/.test(token) || /\bmerge\s+ok\b/.test(token) || /\bpret\s+a\s+merger\b/.test(token)) {
    return "APPROVE";
  }

  return null;
}

/** Dernière directive `VERDICT` / `VERDICT QA` interprétable (prioritaire sur le corps). */
function verdictFromDirectiveLine(qaReport: string): QAVerdict | null {
  QA_VERDICT_DIRECTIVE.lastIndex = 0;
  let last: QAVerdict | null = null;
  let m: RegExpExecArray | null;
  while ((m = QA_VERDICT_DIRECTIVE.exec(qaReport)) !== null) {
    const mapped = mapQAVerdictFromDirectiveValue(m[1]!);
    if (mapped) last = mapped;
  }
  return last;
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

function extractMarkdownSectionByHeading(markdown: string, headingContains: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const target = normalizeAccents(headingContains);
  let startIndex = -1;
  let headingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const [, hashes, text] = m;
    if (normalizeAccents(text).includes(target)) {
      startIndex = i + 1;
      headingLevel = hashes.length;
      break;
    }
  }
  if (startIndex === -1) return null;

  const out: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (m && m[1]!.length <= headingLevel) break;
    out.push(lines[i]!);
  }
  return out.join("\n").trim() || null;
}

function hasExplicitNoCriticalSignal(section: string): boolean {
  const n = normalizeAccents(section);
  return (
    /\baucune?\s+identifiee\b/.test(n) ||
    /\baucune?\s+detectee\b/.test(n) ||
    /\baucune?\s+trouvee\b/.test(n) ||
    /\baucune?\s+critique\s+nouvelle\b/.test(n) ||
    /\baucune?\s+nouvelle\s+critique\b/.test(n) ||
    /\baucune?\s+critique\s+bloquante\b/.test(n) ||
    /\bpas\s+de\s+critique\s+bloquante\b/.test(n) ||
    /\baucune\s+critique\s+nouvelle\s+bloquante\b/.test(n) ||
    /\bno\s+critical\s+vulnerabilit(?:y|ies)\b/.test(n) ||
    /\bnone\s+(?:identified|detected|found)\b/.test(n)
  );
}

function mapSecurityVerdictToken(raw: string): SecurityVerdict | null {
  const t = normalizeAccents(raw.trim().replace(/[`_*]/g, "")).replace(/\s+/g, " ");
  if (!t) return null;
  if (/\bnon\s+approuve|\bpas\s+approuve|\breject/.test(t)) return null;

  if (/\bmedium_issues\b/.test(t) || /\bmedium\b/.test(t) || /\bmoyen(ne)?s?\b/.test(t) || /\bmoyenne\b/.test(t)) {
    return "MEDIUM_ISSUES";
  }
  if (
    /\bcritical_issues\b/.test(t) ||
    /\bcritical\b/.test(t) ||
    /\bbloquant/.test(t) ||
    t === "critique"
  ) {
    return "CRITICAL_ISSUES";
  }
  if (/\bapproved\b/.test(t) || /\bapprouve\b/.test(t) || t === "ok" || t === "pass" || /\baccepte\b/.test(t)) {
    return "APPROVED";
  }
  return null;
}

/** Dernière directive explicite du rapport (la fin du fichier est recommandée dans le prompt). */
function securityVerdictFromDirectiveLine(securityReport: string): SecurityVerdict | null {
  SECURITY_VERDICT_LINE.lastIndex = 0;
  let last: SecurityVerdict | null = null;
  let m: RegExpExecArray | null;
  while ((m = SECURITY_VERDICT_LINE.exec(securityReport)) !== null) {
    const mapped = mapSecurityVerdictToken(m[1]!);
    if (mapped) last = mapped;
  }
  return last;
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

/**
 * Retourne true dès qu’une directive `VERDICT SÉCURITÉ:` / `SECURITY_VERDICT:` parseable
 * est présente dans le texte accumulé — utilisé pour l’arrêt anticipé du stream.
 * N’utilise PAS les heuristiques de fallback pour éviter les faux positifs en cours de génération.
 */
export function hasDefinitiveSecurityVerdict(text: string): boolean {
  const re = /^\s*(?:VERDICT\s*S[ÉE]CURIT[ÉE]|SECURITY_VERDICT|SECURITY\s+VERDICT)\s*[:：]\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (mapSecurityVerdictToken(m[1]!)) return true;
  }
  return false;
}

/**
 * Retourne true dès qu’une directive `VERDICT:` / `VERDICT QA:` parseable est présente.
 * N’utilise PAS les heuristiques de fallback pour éviter les faux positifs en cours de génération.
 */
export function hasDefinitiveQAVerdict(text: string): boolean {
  const re = /^\s*VERDICT(?:\s+QA)?\s*[:：]\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (mapQAVerdictFromDirectiveValue(m[1]!)) return true;
  }
  return false;
}

/** Déduit le niveau d’alerte sécurité à partir du texte du rapport Sécurité. */
export function detectSecurityVerdict(securityReport: string): SecurityVerdict {
  const fromDirective = securityVerdictFromDirectiveLine(securityReport);
  if (fromDirective) return fromDirective;

  const bodySansBlocsCode = stripMarkdownFencedCodeBlocks(securityReport);
  const lowerReport = bodySansBlocsCode.toLowerCase();

  const criticalSection = extractMarkdownSectionByHeading(bodySansBlocsCode, "vulnérabilités critiques");
  if (criticalSection && hasExplicitNoCriticalSignal(criticalSection)) {
    // On continue pour détecter d'éventuelles vulnérabilités moyennes.
  } else if (
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
