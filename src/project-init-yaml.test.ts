import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it } from "node:test";
import {
  buildProjectMarkdownFromTemplate,
  initProjectFromYamlManifest,
  normalizeProjectRepoUrl,
  parseProjectYamlManifest,
  projectSlugFromManifestPath,
  resolveProjectManifestPath,
} from "./project-init-yaml.js";

describe("parseProjectYamlManifest", () => {
  it("parse un manifeste plat avec commentaires", () => {
    const manifest = parseProjectYamlManifest(`
# commentaire
name: Mon Projet
repo: org/repo
branch: main
local_path: ~/code/dev/repo
`);
    assert.equal(manifest.name, "Mon Projet");
    assert.equal(manifest.repo, "org/repo");
    assert.equal(manifest.branch, "main");
    assert.equal(manifest.local_path, "~/code/dev/repo");
  });

  it("rejette une clé obligatoire manquante", () => {
    assert.throws(
      () =>
        parseProjectYamlManifest(`
name: X
repo: org/repo
branch: main
`),
      /local_path/,
    );
  });
});

describe("normalizeProjectRepoUrl", () => {
  it("convertit owner/repo en URL GitHub", () => {
    assert.equal(normalizeProjectRepoUrl("acme/app"), "https://github.com/acme/app");
  });

  it("accepte une URL GitHub", () => {
    assert.equal(
      normalizeProjectRepoUrl("https://github.com/acme/app.git"),
      "https://github.com/acme/app",
    );
  });
});

describe("projectSlugFromManifestPath", () => {
  it("dérive le slug depuis .yaml", () => {
    assert.equal(projectSlugFromManifestPath("/tmp/projects/acme.yaml"), "acme");
  });

  it("dérive le slug depuis .project.yaml", () => {
    assert.equal(projectSlugFromManifestPath("/tmp/projects/acme.project.yaml"), "acme");
  });
});

describe("initProjectFromYamlManifest", () => {
  it("génère projects/<slug>.md depuis le template", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-init-"));
    const repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    const projectsDir = join(root, "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "_template.md"),
      `---
name: Placeholder
repo: https://github.com/org/placeholder
branch: main
---

## Vue d'ensemble

Corps template
`,
    );
    const manifestPath = join(projectsDir, "acme.yaml");
    writeFileSync(
      manifestPath,
      `name: Acme
repo: acme/app
branch: develop
local_path: ${repoDir}
`,
    );

    const result = initProjectFromYamlManifest({
      repoRoot: root,
      manifestPath,
    });

    assert.equal(result.slug, "acme");
    assert.equal(result.outputPath, join(projectsDir, "acme.md"));
    assert.ok(existsSync(result.outputPath));
    const md = readFileSync(result.outputPath, "utf-8");
    assert.match(md, /name: Acme/);
    assert.match(md, /repo: ['"]?https:\/\/github\.com\/acme\/app['"]?/);
    assert.match(md, /branch: develop/);
    assert.match(md, /local_path: .*repo/);
    assert.match(md, /## Vue d'ensemble/);
  });

  it("refuse d'écraser sans --force", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-init-"));
    const repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    const projectsDir = join(root, "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "_template.md"),
      `---
name: Placeholder
repo: https://github.com/org/placeholder
branch: main
---

Corps
`,
    );
    const manifestPath = join(projectsDir, "acme.yaml");
    writeFileSync(
      manifestPath,
      `name: Acme
repo: acme/app
branch: main
local_path: ${repoDir}
`,
    );
    initProjectFromYamlManifest({ repoRoot: root, manifestPath });
    assert.throws(
      () => initProjectFromYamlManifest({ repoRoot: root, manifestPath }),
      /déjà présent/,
    );
  });
});

describe("buildProjectMarkdownFromTemplate", () => {
  it("remplace le frontmatter et conserve le corps", () => {
    const md = buildProjectMarkdownFromTemplate(
      `---
name: Old
repo: https://github.com/old/repo
branch: main
---

## Section
`,
      {
        name: "New",
        repo: "new/repo",
        branch: "dev",
        local_path: "~/clone",
      },
    );
    assert.match(md, /name: New/);
    assert.match(md, /repo: ['"]?https:\/\/github\.com\/new\/repo['"]?/);
    assert.match(md, /branch: dev/);
    assert.match(md, /local_path: ~\/clone/);
    assert.match(md, /## Section/);
  });
});

describe("resolveProjectManifestPath", () => {
  it("résout un slug vers projects/<slug>.yaml", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-init-"));
    const projectsDir = join(root, "projects");
    mkdirSync(projectsDir, { recursive: true });
    const manifest = join(projectsDir, "acme.yaml");
    writeFileSync(manifest, "name: x\nrepo: a/b\nbranch: main\nlocal_path: /tmp\n");
    assert.equal(resolveProjectManifestPath(root, "acme"), manifest);
  });
});
