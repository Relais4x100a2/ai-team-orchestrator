import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadProject } from "../src/orchestrator/project-loader.js";
import {
  initProjectFromYamlManifest,
  resolveProjectManifestPath,
} from "../src/project-init-yaml.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");

function usage(): void {
  console.log(`
Usage :
  npm run project:init -- <slug|manifest.yaml> [--force]

Exemples :
  cp projects/_template.project.yaml projects/monprojet.yaml
  npm run project:init -- monprojet

  npm run project:init -- projects/monprojet.yaml --force
`);
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const force = args.includes("--force");
  const positional = args.filter((a) => a !== "--force");

  if (positional.length === 0 || positional.includes("-h") || positional.includes("--help")) {
    usage();
    process.exit(positional.length === 0 ? 1 : 0);
  }

  const input = positional[0]!;
  let manifestPath: string;
  try {
    manifestPath = resolveProjectManifestPath(REPO_ROOT, input);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }

  try {
    const result = initProjectFromYamlManifest({
      repoRoot: REPO_ROOT,
      manifestPath,
      force,
    });
    loadProject(result.outputPath);
    console.log(`✅ Projet initialisé : ${result.outputPath}`);
    console.log(`   Manifeste : ${result.manifestPath}`);
    console.log(`   Slug CLI : ${result.slug}`);
    console.log(`\nProchaines étapes :`);
    console.log(`  npm run project -- ${result.slug} --role pm "…"`);
    console.log(`  npm run project -- ${result.slug} --pipeline backlog forward "…"`);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
