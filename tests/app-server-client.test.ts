import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex/app-server-client.js";

test("app-server client initializes once and correlates JSON-RPC responses", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-fake-"));
  const fake = path.join(dir, "codex");
  const script = `#!/usr/bin/env node\n` +
    `const readline = require('node:readline');\n` +
    `const rl = readline.createInterface({ input: process.stdin });\n` +
    `rl.on('line', line => {\n` +
    `  const m = JSON.parse(line);\n` +
    `  if (m.method === 'initialize') process.stdout.write(JSON.stringify({id:m.id,result:{serverInfo:{name:'fake'}}})+'\\n');\n` +
    `  else if (m.method === 'account/read') process.stdout.write(JSON.stringify({id:m.id,result:{authMode:'test'}})+'\\n');\n` +
    `});\n`;
  await fs.writeFile(fake, script, { mode: 0o755 });

  const client = new CodexAppServerClient(fake, undefined, 3000);
  await Promise.all([client.ensureStarted(), client.ensureStarted()]);
  const account = await client.request("account/read", {});
  assert.equal(account.authMode, "test");
  await client.stop();
});
