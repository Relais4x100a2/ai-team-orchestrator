/**
 * AI Team Orchestrator — point d'entrée CLI.
 * Logique découpée dans `src/orchestrator/` (voir .cursor/plans/orchestrator-modularisation.md).
 */
import "dotenv/config";
import { setupRipgrepPath } from "./orchestrator/paths-and-env.js";
import { main } from "./orchestrator/cli.js";

setupRipgrepPath();

main().catch((err) => {
  console.error("❌ Erreur fatale :", err.message);
  process.exit(1);
});
