import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const summaryPath = resolve(process.cwd(), "coverage", "coverage-summary.json");
const baselinePath = resolve(process.cwd(), ".coverage-baseline.json");

const summary = readJson(summaryPath);
const baseline = readJson(baselinePath);

const currentLines = Number(summary?.total?.lines?.pct ?? NaN);
const baselineLines = Number(baseline?.linesPct ?? NaN);
const explicitTarget = process.env.COVERAGE_TARGET_LINES_PCT;
const minDelta = Number(process.env.COVERAGE_MIN_DELTA_PCT ?? "0.1");

if (!Number.isFinite(currentLines)) {
  throw new Error("Impossible de lire le pourcentage de couverture (lines.pct) dans coverage-summary.json.");
}
if (!Number.isFinite(baselineLines)) {
  throw new Error("Impossible de lire linesPct dans .coverage-baseline.json.");
}
if (!Number.isFinite(minDelta) || minDelta < 0) {
  throw new Error("COVERAGE_MIN_DELTA_PCT doit être un nombre >= 0.");
}

const target = explicitTarget !== undefined
  ? Number(explicitTarget)
  : baselineLines + minDelta;

if (!Number.isFinite(target)) {
  throw new Error("COVERAGE_TARGET_LINES_PCT doit être un nombre valide.");
}

if (currentLines + Number.EPSILON < baselineLines) {
  console.error(
    `❌ Coverage gate: régression détectée (${currentLines.toFixed(2)}% < baseline ${baselineLines.toFixed(2)}%).`
  );
  process.exit(1);
}

if (currentLines + Number.EPSILON < target) {
  const targetLabel = explicitTarget !== undefined
    ? `${target.toFixed(2)}% (objectif explicite)`
    : `${target.toFixed(2)}% (baseline + ${minDelta.toFixed(2)} pt)`;
  console.error(
    `❌ Coverage gate: couverture insuffisante (${currentLines.toFixed(2)}% < cible ${targetLabel}).`
  );
  process.exit(1);
}

console.log(
  `✅ Coverage gate OK: ${currentLines.toFixed(2)}% (baseline ${baselineLines.toFixed(2)}%, cible ${target.toFixed(2)}%).`
);
