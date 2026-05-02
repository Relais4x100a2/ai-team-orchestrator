import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { PipelineRun, PipelineRunsFile } from "./models.js";
import { parsePipelineRunsFile } from "./models.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_RUNS_PATH = resolve(__dirname, "../pipeline-runs.json");

export function loadPipelineRuns(): PipelineRunsFile {
  if (!existsSync(PIPELINE_RUNS_PATH)) {
    return { version: 1, runs: [] };
  }
  const rawText = readFileSync(PIPELINE_RUNS_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(
      `pipeline-runs.json : JSON invalide. Corrige ou renomme le fichier pour repartir à zéro.`
    );
  }
  return parsePipelineRunsFile(parsed);
}

export function appendPipelineRun(run: PipelineRun): void {
  const file = loadPipelineRuns();
  file.runs.push(run);
  writeFileSync(PIPELINE_RUNS_PATH, JSON.stringify(file, null, 2), "utf-8");
}

export function getPipelineRunsPath(): string {
  return PIPELINE_RUNS_PATH;
}
