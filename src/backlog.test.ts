import { describe, it } from "node:test";
import assert from "node:assert";
import type { Backlog, BacklogIssue } from "./backlog.js";
import {
  generateIssueId,
  parsePMOutput,
  pickNextIssue,
} from "./backlog.js";

const baseIssue = (): BacklogIssue => ({
  id: "issue-001",
  title: "T",
  description: "d",
  status: "todo",
  priority: "SHOULD",
  size: "M",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  completedAt: null,
  pipelineRun: null,
});

describe("parsePMOutput", () => {
  it("extrait une issue avec titre h1, priorité et taille", () => {
    // Un « --- » à l’intérieur d’une même story découperait le bloc (comportement split actuel).
    const pm = `
# Import CSV

## 🎯 User Story
En tant qu’utilisateur je veux importer des CSV.

## 🏷️ Priorité

MUST

## 📏 Taille estimée

S
`;
    const issues = parsePMOutput(pm);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]!.title, "Import CSV");
    assert.strictEqual(issues[0]!.priority, "MUST");
    assert.strictEqual(issues[0]!.size, "S");
  });

  it("parse « je veux … afin de » si pas de h1", () => {
    const pm = `## 🎯 User Story

je veux uploader un fichier
afin de l'analyser

## 🏷️ Priorité

COULD

## 📏 Taille estimée

XL
`;
    const issues = parsePMOutput(pm);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0]!.title.includes("uploader"));
    assert.strictEqual(issues[0]!.priority, "COULD");
    assert.strictEqual(issues[0]!.size, "XL");
  });

  it("retourne tableau vide si aucun bloc User Story", () => {
    assert.deepStrictEqual(parsePMOutput("Pas d'issue ici."), []);
  });
});

describe("generateIssueId", () => {
  it("numérote à partir du max existant", () => {
    const backlog: Backlog = {
      version: 1,
      lastUpdated: "",
      issues: [
        { ...baseIssue(), id: "issue-002" },
        { ...baseIssue(), id: "issue-010" },
      ],
    };
    assert.strictEqual(generateIssueId(backlog), "issue-011");
  });

  it("commence à issue-001 sur backlog vide", () => {
    const backlog: Backlog = { version: 1, lastUpdated: "", issues: [] };
    assert.strictEqual(generateIssueId(backlog), "issue-001");
  });

  it("ignore les ids non conformes au schéma issue-\\d+", () => {
    const backlog: Backlog = {
      version: 1,
      lastUpdated: "",
      issues: [
        { ...baseIssue(), id: "foo" },
        { ...baseIssue(), id: "issue-005" },
        { ...baseIssue(), id: "issue-invalid" },
      ],
    };
    assert.strictEqual(generateIssueId(backlog), "issue-006");
  });
});

describe("pickNextIssue", () => {
  it("ignore WONT et choisit MUST avant SHOULD", () => {
    const backlog: Backlog = {
      version: 1,
      lastUpdated: "",
      issues: [
        { ...baseIssue(), id: "a", priority: "WONT", status: "todo" },
        { ...baseIssue(), id: "b", priority: "SHOULD", status: "todo" },
        { ...baseIssue(), id: "c", priority: "MUST", status: "todo", size: "L" },
        { ...baseIssue(), id: "d", priority: "MUST", status: "todo", size: "S" },
      ],
    };
    const next = pickNextIssue(backlog);
    assert.strictEqual(next?.id, "d");
  });

  it("retourne null si aucun todo exploitable", () => {
    const backlog: Backlog = {
      version: 1,
      lastUpdated: "",
      issues: [{ ...baseIssue(), status: "done" }],
    };
    assert.strictEqual(pickNextIssue(backlog), null);
  });
});
