import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, it } from "node:test";
import {
  createSprint,
  loadSprintIndex,
  migrateLegacyBacklogToSprint,
  resolveSprintIndexPath,
  updateSprintIssueCount,
} from "./sprint-io.js";

describe("createSprint", () => {
  it("crée le répertoire du sprint et met à jour index.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    const id = createSprint(tmp, "forward", "Test brief");
    assert.ok(id.length === 26, "ULID attendu");
    assert.ok(existsSync(resolve(tmp, "sprints", id)));
    const index = loadSprintIndex(tmp);
    assert.ok(index !== null);
    assert.equal(index!.activeSprint, id);
    assert.equal(index!.sprints.length, 1);
    assert.equal(index!.sprints[0].direction, "forward");
    assert.equal(index!.sprints[0].brief, "Test brief");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("le deuxième sprint s'ajoute à l'index et devient actif", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    const id1 = createSprint(tmp, "forward", "Sprint 1");
    const id2 = createSprint(tmp, "backward", "Sprint 2");
    const index = loadSprintIndex(tmp);
    assert.equal(index!.activeSprint, id2);
    assert.equal(index!.sprints.length, 2);
    assert.ok(index!.sprints.some(s => s.id === id1));
    assert.ok(index!.sprints.some(s => s.id === id2));
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("loadSprintIndex", () => {
  it("retourne null quand index.json absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    assert.equal(loadSprintIndex(tmp), null);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("updateSprintIssueCount", () => {
  it("met à jour issueCount du sprint actif", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    const id = createSprint(tmp, "forward", "Brief");
    updateSprintIssueCount(tmp, id, 5);
    const index = loadSprintIndex(tmp);
    assert.equal(index!.sprints[0].issueCount, 5);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("migrateLegacyBacklogToSprint", () => {
  it("déplace backlog.json dans sprints/<ULID>/ et crée index.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    writeFileSync(resolve(tmp, "backlog.json"), '{"version":2,"issues":[]}', "utf-8");
    migrateLegacyBacklogToSprint(tmp);
    // backlog.json ne doit plus être à la racine
    assert.ok(!existsSync(resolve(tmp, "backlog.json")));
    // index.json doit exister
    const indexPath = resolveSprintIndexPath(tmp);
    assert.ok(existsSync(indexPath));
    const index = loadSprintIndex(tmp);
    assert.ok(index !== null);
    const sprintId = index!.activeSprint;
    assert.ok(existsSync(resolve(tmp, "sprints", sprintId, "backlog.json")));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ne fait rien si sprints/ existe déjà", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    mkdirSync(resolve(tmp, "sprints"), { recursive: true });
    writeFileSync(resolve(tmp, "backlog.json"), "{}", "utf-8");
    migrateLegacyBacklogToSprint(tmp);
    // backlog.json toujours à la racine
    assert.ok(existsSync(resolve(tmp, "backlog.json")));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ne fait rien si backlog.json absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sprint-"));
    migrateLegacyBacklogToSprint(tmp); // ne doit pas lancer d'exception
    assert.ok(!existsSync(resolve(tmp, "sprints")));
    rmSync(tmp, { recursive: true, force: true });
  });
});
