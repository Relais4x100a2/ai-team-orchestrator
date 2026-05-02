/**
 * Heuristiques minimales pour interpréter les rapports QA / Red Team dans le pipeline.
 */

export type QAVerdict = "APPROVE" | "REQUEST_CHANGES";

export type SecurityVerdict = "APPROVED" | "CRITICAL_ISSUES" | "MEDIUM_ISSUES";

/** Déduit si QA approuve ou demande des changements à partir du texte du rapport. */
export function detectQAVerdict(qaReport: string): QAVerdict {
  const lowerReport = qaReport.toLowerCase();
  if (
    lowerReport.includes("request changes") ||
    lowerReport.includes("request_changes")
  ) {
    return "REQUEST_CHANGES";
  }
  return "APPROVE";
}

/** Déduit le niveau d’alerte sécurité à partir du texte du rapport Red Team. */
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
