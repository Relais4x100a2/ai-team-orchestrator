import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it } from "node:test";
import { buildCodeSnapshot } from "./code-snapshot.js";

describe("buildCodeSnapshot", () => {
  it("retourne le contenu de context.md quand il existe dans projectDataDir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "snap-"));
    const dataDir = join(tmp, ".ai-team-orchestrator");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "context.md"), "# Contexte\nStacktech : TypeScript.", "utf-8");
    const result = buildCodeSnapshot(tmp, dataDir);
    assert.ok(result.includes("Contexte"));
    assert.ok(result.includes("TypeScript"));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("retourne un snapshot git quand context.md est absent", () => {
    // Utilise le repo de l'orchestrateur lui-même comme localPath de test
    const localPath = process.cwd();
    const result = buildCodeSnapshot(localPath, undefined);
    // Doit contenir au moins une des sections attendues
    assert.ok(
      result.includes("Commits récents") || result.includes("Structure") || result.includes("Snapshot"),
    );
  });

  it("tronque à ~2000 caractères max", () => {
    const tmp = mkdtempSync(join(tmpdir(), "snap-"));
    const dataDir = join(tmp, ".ai-team-orchestrator");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "context.md"), "x".repeat(5000), "utf-8");
    const result = buildCodeSnapshot(tmp, dataDir);
    assert.ok(result.length <= 2100); // marge pour le label
    assert.ok(result.includes("[…tronqué]"));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("bascule sur le snapshot git si context.md est plus vieux que le dernier commit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "snap-"));
    const dataDir = join(tmp, ".ai-team-orchestrator");
    mkdirSync(dataDir, { recursive: true });
    const contextPath = join(dataDir, "context.md");
    writeFileSync(contextPath, "# Vieux contexte\nContenu périmé.", "utf-8");
    // Set mtime to 30 days ago — older than any recent commit in this repo
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(contextPath, thirtyDaysAgo, thirtyDaysAgo);
    // Use orchestrator repo as localPath — has a recent commit
    const result = buildCodeSnapshot(process.cwd(), dataDir);
    assert.ok(!result.includes("Vieux contexte"), "ne doit pas utiliser le context.md périmé");
    assert.ok(!result.includes("Contenu périmé"), "ne doit pas utiliser le context.md périmé");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("retourne une chaîne non vide même si git échoue", () => {
    const tmp = mkdtempSync(join(tmpdir(), "snap-"));
    // Pas de repo git ici — les execFileSync doivent être silencieux
    const result = buildCodeSnapshot(tmp, undefined);
    assert.ok(result.length > 0);
    rmSync(tmp, { recursive: true, force: true });
  });
});
