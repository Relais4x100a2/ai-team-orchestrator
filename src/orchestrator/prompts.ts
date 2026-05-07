import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { SRC_DIR } from "./paths-and-env.js";

export function loadPrompt(role: string): string {
  const path = resolve(SRC_DIR, "prompts", `${role}.md`);
  if (!existsSync(path)) {
    throw new Error(`Prompt introuvable : ${path}`);
  }
  return readFileSync(path, "utf-8");
}
