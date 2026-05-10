import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { describe, it } from "node:test";
import { join } from "path";
import { mkdirWithDefaultGitignoreIfNeeded } from "./paths-and-env.js";
import { loadProject } from "./project-loader.js";

function writeProjectFile(path: string, body: string): void {
  writeFileSync(path, body, "utf-8");
}

describe("loadProject", () => {
  it("rejette project_data_dir sans local_path", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-pl-"));
    const md = join(root, "p.md");
    writeProjectFile(
      md,
      `---
name: T
repo: https://github.com/a/b
branch: main
project_data_dir: custom
---

Corps
`,
    );
    assert.throws(() => loadProject(md), /local_path/);
  });

  it("rejette project_data_dir avec traversée ..", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-pl-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const md = join(root, "p.md");
    writeProjectFile(
      md,
      `---
name: T
repo: https://github.com/a/b
branch: main
local_path: ${repo}
project_data_dir: ../escape
---

`,
    );
    assert.throws(() => loadProject(md), /\.\./);
  });

  it("rejette project_data_dir absolu", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-pl-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const md = join(root, "p.md");
    writeProjectFile(
      md,
      `---
name: T
repo: https://github.com/a/b
branch: main
local_path: ${repo}
project_data_dir: /etc
---

`,
    );
    assert.throws(() => loadProject(md), /absolu/);
  });

  it("rejette un data dir qui sort du repo via symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-pl-"));
    const local = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(local, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(local, ".ai-team-orchestrator"), "dir");
    const md = join(root, "p.md");
    writeProjectFile(
      md,
      `---
name: T
repo: https://github.com/a/b
branch: main
local_path: ${local}
---

`,
    );
    assert.throws(() => loadProject(md), /données doit rester sous le dépôt local/);
  });

  it("rejette project_context explicite si le fichier est absent", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-pl-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const md = join(root, "p.md");
    writeProjectFile(
      md,
      `---
name: T
repo: https://github.com/a/b
branch: main
local_path: ${repo}
project_context: manquant.md
---

Corps secours
`,
    );
    assert.throws(() => loadProject(md), /project_context/);
  });

  it("utilise le corps du .md projet si pas de context.md ni project_context", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-pl-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const md = join(root, "p.md");
    writeProjectFile(
      md,
      `---
name: T
repo: https://github.com/a/b
branch: main
local_path: ${repo}
---

Hi from body
`,
    );
    const p = loadProject(md);
    assert.equal(p.content, "Hi from body");
  });

  it("lit context.md par défaut s’il existe", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-pl-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".ai-team-orchestrator"), { recursive: true });
    writeFileSync(join(repo, ".ai-team-orchestrator", "context.md"), "FROM_CTX\n", "utf-8");
    const md = join(root, "p.md");
    writeProjectFile(
      md,
      `---
name: T
repo: https://github.com/a/b
branch: main
local_path: ${repo}
---

Ignored body
`,
    );
    const p = loadProject(md);
    assert.equal(p.content, "FROM_CTX");
  });
});

describe("mkdirWithDefaultGitignoreIfNeeded", () => {
  it("crée un .gitignore minimal sur premier mkdir du dossier", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-git-"));
    const dir = join(root, "data");
    assert.equal(existsSync(dir), false);
    mkdirWithDefaultGitignoreIfNeeded(dir);
    assert.ok(existsSync(join(dir, ".gitignore")));
    const g = readFileSync(join(dir, ".gitignore"), "utf-8");
    assert.match(g, /\*/);
    assert.match(g, /!\.gitignore/);
  });

  it("ne remplace pas un .gitignore existant", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-git-"));
    mkdirSync(join(root, "data"), { recursive: true });
    const gi = join(root, "data", ".gitignore");
    writeFileSync(gi, "custom\n", "utf-8");
    mkdirWithDefaultGitignoreIfNeeded(join(root, "data"));
    assert.equal(readFileSync(gi, "utf-8"), "custom\n");
  });
});
