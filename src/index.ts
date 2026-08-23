import { loadConfig } from "./config.js";
import { Orchestrator } from "./core/orchestrator.js";
import { startHttpServer } from "./http.js";

async function main() {
  const config = loadConfig();
  const orchestrator = new Orchestrator(config);
  await orchestrator.init();
  startHttpServer(config, orchestrator);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
