import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once("line", (line) => {
  const start = JSON.parse(line);
  const recipe = start.recipes[0];
  const containerId = "c".repeat(64);
  const containerIdHash = createHash("sha256").update(containerId).digest("hex");
  const labels = {
    "io.openai.codex-supervisor.task": start.taskId,
    "io.openai.codex-supervisor.run": start.runId,
    "io.openai.codex-supervisor.worker": start.workerId,
    "io.openai.codex-supervisor.recipe": recipe.id,
    "io.openai.codex-supervisor.image-digest": start.runtime.image,
    "io.openai.codex-supervisor.engine": start.runtime.engine,
    "io.openai.codex-supervisor.engine-namespace": start.runtimeBinding.engineInstanceHash
  };
  const containerLabelsHash = createHash("sha256")
    .update(JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
  let sequence = 0;
  const emit = (event) => process.stdout.write(`${JSON.stringify({
    ...event,
    runId: start.runId,
    workerId: start.workerId,
    sequence: ++sequence,
    at: new Date().toISOString()
  })}\n`);
  emit({
    type: "recipe_started",
    recipeId: recipe.id,
    execution: {
      backend: "oci",
      engine: start.runtime.engine,
      assurance: "high",
      containerId,
      containerIdHash,
      containerLabelsHash,
      containerEngineNamespaceHash: start.runtimeBinding.engineInstanceHash
    }
  });
  emit({
    type: "termination_completed",
    recipeId: recipe.id,
    terminationEvidence: {
      backend: "oci",
      engine: start.runtime.engine,
      assurance: "high",
      containerIdHash,
      containerImageDigest: start.runtime.image,
      containerLabelsHash,
      containerEngineNamespaceHash: start.runtimeBinding.engineInstanceHash,
      ownershipVerified: true,
      provenComplete: true,
      requiredIntervention: true
    }
  });
  emit({ type: "recipe_completed", recipeId: recipe.id, exitCode: 0, passed: true });
  emit({ type: "verification_completed", passed: true });
});
