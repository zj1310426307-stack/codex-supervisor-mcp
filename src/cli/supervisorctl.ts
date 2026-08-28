#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { SupervisorFacade } from "../mcp/facade.js";
import {
  defaultReadText,
  OperatorRiskRejectedError,
  OperatorUsageError,
  operatorUsage,
  redactOperatorText,
  runOperatorCommand,
  type OperatorIo
} from "./operator.js";

function terminalIo(): OperatorIo {
  return {
    readText: defaultReadText,
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    confirm: async (operation) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) return false;
      const expected = `CONFIRM ${operation}`;
      const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await prompt.question(
          `High-risk local operation: ${operation}\nType exactly \"${expected}\" to continue: `
        );
        return answer === expected;
      } finally {
        prompt.close();
      }
    }
  };
}

async function main(argv: string[]): Promise<void> {
  const [{ loadConfig }, { Orchestrator }] = await Promise.all([
    import("../config.js"),
    import("../core/orchestrator.js")
  ]);
  const orchestrator = new Orchestrator(loadConfig()) as unknown as SupervisorFacade & {
    init(): Promise<void>;
    stop(): Promise<void>;
  };
  await orchestrator.init();
  try {
    await runOperatorCommand(argv, orchestrator, terminalIo());
  } finally {
    await orchestrator.stop();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  main(process.argv.slice(2)).catch((error) => {
    const code =
      error instanceof OperatorUsageError || error instanceof OperatorRiskRejectedError
        ? error.code
        : "OPERATOR_FAILED";
    process.stderr.write(
      `${redactOperatorText(
        JSON.stringify(
          { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } },
          null,
          2
        )
      )}\n`
    );
    if (error instanceof OperatorUsageError) process.stderr.write(`${operatorUsage}\n`);
    process.exitCode = 1;
  });
}

export { main as runSupervisorCtl };
