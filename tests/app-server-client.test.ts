import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexAppServerClient,
  CodexConnectionPoisonedError,
  CodexRpcError
} from "../src/codex/app-server-client.js";
import { evaluateProtocolCapabilities } from "../src/codex/protocol-capabilities.js";
import { REQUIRED_PROTOCOL_SHAPES } from "../src/codex/protocol-schema.js";
import { REQUIRED_STABLE_CLIENT_METHODS, REQUIRED_STABLE_SERVER_METHODS } from "../src/codex/protocol-values.js";

async function fakeServer(mode = "normal") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-fake-"));
  const scriptPath = path.join(directory, "fake-app-server.cjs");
  const logPath = path.join(directory, "wire.jsonl");
  const script = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const readline = require('node:readline');",
    "const log = process.argv[2];",
    "const mode = process.argv[3];",
    "let initResponded = false; let initialized = false; let reads = 0;",
    "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    "if (mode === 'init-error-ignore-term' || mode === 'mutation-timeout') {",
    "  process.on('SIGTERM', () => fs.appendFileSync(log, JSON.stringify({_fakeEvent:'sigterm',pid:process.pid}) + '\\n'));",
    "}",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', line => {",
    "  fs.appendFileSync(log, line + '\\n');",
    "  const m = JSON.parse(line);",
    "  if ('jsonrpc' in m) process.exit(20);",
    "  if (m.method === 'initialize') {",
    "    if (mode === 'init-error-ignore-term') send({id:m.id,error:{code:-32099,message:'initialize failed'}});",
    "    else setTimeout(() => { initResponded = true; send({id:m.id,result:{userAgent:'fake',platformFamily:'test',platformOs:'test'}}); }, 30);",
    "  } else if (m.method === 'initialized') {",
    "    if (!initResponded) process.exit(21);",
    "    initialized = true;",
    "    if (mode !== 'tail-exit') {",
    "      send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});",
    "      send({method:'item/commandExecution/requestApproval',id:'server-1',params:{threadId:'thread-1'}});",
    "    }",
    "  } else if (m.method === 'account/read') {",
    "    if (!initialized) process.exit(22);",
    "    reads += 1;",
    "    if (mode === 'retry' && reads === 1) send({id:m.id,error:{code:-32001,message:'Server overloaded; retry later.'}});",
    "    else send({id:m.id,result:{authMode:'test',reads}});",
    "  } else if (m.method === 'thread/start') {",
    "    if (mode === 'write-ambiguous') {}",
    "    else if (mode === 'mutation-timeout') setTimeout(() => send({id:m.id,result:{thread:{id:'late-thread'}}}), 1150);",
    "    else send({id:m.id,error:{code:-32001,message:'Server overloaded; retry later.'}});",
    "  } else if (m.method === 'test/emit-malformed') {",
    "    process.stdout.write('{not-json\\n');",
    "  } else if (m.method === 'test/emit-overlong-json') {",
    "    process.stdout.write('x'.repeat(1024));",
    "  } else if (m.method === 'test/emit-overlong-stderr') {",
    "    process.stderr.write('s'.repeat(128) + '\\n' + 'after-truncation\\n');",
    "  } else if (m.method === 'test/emit-tail') {",
    "    const tail = JSON.stringify({method:'turn/completed',params:{turn:{id:'turn-tail',status:'completed'}}}) + '\\n';",
    "    const code = 'setTimeout(() => { require(\\'node:fs\\').writeSync(1, ' + JSON.stringify(tail) + '); process.exit(0); }, 50)';",
    "    const writer = spawn(process.execPath, ['-e', code], {stdio:['ignore', 1, 'ignore'], detached:true});",
    "    writer.unref();",
    "    process.exit(0);",
    "  }",
    "});",
    "rl.on('close', () => { if (mode !== 'init-error-ignore-term' && mode !== 'mutation-timeout') process.exit(0); });"
  ].join("\n");
  await fs.writeFile(scriptPath, script, "utf8");
  return {
    directory,
    logPath,
    options: { appServerArgs: [scriptPath, logPath, mode] },
    cleanup: () => fs.rm(directory, { recursive: true, force: true })
  };
}

async function readWire(logPath: string): Promise<any[]> {
  const text = await fs.readFile(logPath, "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForWire(logPath: string, predicate: (messages: any[]) => boolean): Promise<any[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const messages = await readWire(logPath);
      if (predicate(messages)) return messages;
    } catch {
      // The fake process may not have created the log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake app-server wire log");
}

function protocolBinding(version: string) {
  return {
    version,
    schemaHash: "a".repeat(64),
    capabilities: evaluateProtocolCapabilities(
      [...REQUIRED_STABLE_CLIENT_METHODS, ...REQUIRED_STABLE_SERVER_METHODS],
      {
        shapeValidation: {
          compatible: true,
          requiredShapes: [...REQUIRED_PROTOCOL_SHAPES],
          validatedShapes: [...REQUIRED_PROTOCOL_SHAPES],
          shapeErrors: []
        }
      }
    )
  };
}

function injectDeliveredWriteFailure(
  client: CodexAppServerClient,
  predicate: (message: any) => boolean,
  beforeFailure: (message: any) => Promise<void> = async () => undefined
): () => void {
  const target = client as unknown as {
    writeLine: (message: any, child: unknown) => Promise<void>;
  };
  const original = target.writeLine.bind(client);
  target.writeLine = async (message, child) => {
    await original(message, child);
    if (predicate(message)) {
      await beforeFailure(message);
      throw Object.assign(new Error("injected stdin write callback failure"), { code: "EPIPE" });
    }
  };
  return () => { target.writeLine = original; };
}

test("client awaits initialize response, sends initialized once, and keeps stdin open", async () => {
  const fake = await fakeServer();
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, fake.options);
  const notification = once(client, "notification");
  const serverRequest = once(client, "serverRequest");
  try {
    await Promise.all([client.ensureStarted(), client.ensureStarted()]);
    assert.equal(client.connectionCount(), 1);
    assert.equal(client.isReady(), true);

    const account = await client.request("account/read", {});
    assert.equal(account.authMode, "test");
    const [notice] = await notification;
    assert.equal(notice.method, "turn/started");
    const [request] = await serverRequest;
    assert.equal(request.id, "server-1");
    await client.respond(request.id, { decision: "decline" });

    const messages = await waitForWire(fake.logPath, (wire) => wire.some((item) => item.id === "server-1"));
    assert.deepEqual(messages.slice(0, 3).map((item) => item.method), ["initialize", "initialized", "account/read"]);
    assert.equal(messages.filter((item) => item.method === "initialize").length, 1);
    assert.equal(messages.some((item) => "jsonrpc" in item), false);
    assert.equal(messages.some((item) => item.id === "server-1" && item.result?.decision === "decline"), true);

    const stopped = await client.stop();
    assert.equal(stopped.alreadyStopped, false);
    assert.equal(client.isReady(), false);
    assert.equal((await client.stop()).alreadyStopped, true);
    await assert.rejects(client.request("account/read", {}), /client is closed/);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("bounded retries apply to read-only methods but never mutation methods", async () => {
  const fake = await fakeServer("retry");
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, {
    ...fake.options,
    maxReadRetries: 1,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    retryJitter: 0
  });
  try {
    const account = await client.request("account/read", {});
    assert.equal(account.reads, 2);
    await assert.rejects(
      client.request("thread/start", {}),
      (error: unknown) => error instanceof CodexRpcError && error.code === -32001
    );
    const messages = await readWire(fake.logPath);
    assert.equal(messages.filter((item) => item.method === "account/read").length, 2);
    assert.equal(messages.filter((item) => item.method === "thread/start").length, 1);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("failed initialize proves process exit before cleanup completes", async () => {
  const fake = await fakeServer("init-error-ignore-term");
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, {
    ...fake.options,
    shutdownTimeoutMs: 40,
    killTimeoutMs: 2_000
  });
  type WaitForExit = <T>(exit: Promise<T>, timeoutMs: number) => Promise<T | undefined>;
  let releaseGraceBoundary: (() => void) | undefined;
  let graceWaitStarted: Promise<void> | undefined;
  let restoreWaitForExit = () => undefined;
  let childAtGraceBoundary: { signalCode: NodeJS.Signals | null } | undefined;
  const observedWaits: number[] = [];

  if (process.platform !== "win32") {
    // Gate the first exit wait so signal ordering is asserted without comparing
    // wall-clock durations on a loaded CI host.
    const target = client as unknown as {
      child?: { signalCode: NodeJS.Signals | null };
      waitForExit: WaitForExit;
    };
    const originalWaitForExit = target.waitForExit.bind(client) as WaitForExit;
    let markGraceWaitStarted!: () => void;
    graceWaitStarted = new Promise<void>((resolve) => { markGraceWaitStarted = resolve; });
    const graceBoundary = new Promise<void>((resolve) => { releaseGraceBoundary = resolve; });
    target.waitForExit = async <T>(exit: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
      observedWaits.push(timeoutMs);
      if (observedWaits.length === 1) {
        childAtGraceBoundary = target.child;
        markGraceWaitStarted();
        await graceBoundary;
        return undefined;
      }
      return originalWaitForExit(exit, timeoutMs);
    };
    restoreWaitForExit = () => { target.waitForExit = originalWaitForExit; };
  }

  let startSettled = false;
  const startResult = client.ensureStarted().then(
    () => {
      startSettled = true;
      return { ok: true as const };
    },
    (error: unknown) => {
      startSettled = true;
      return { ok: false as const, error };
    }
  );
  try {
    if (graceWaitStarted) {
      await graceWaitStarted;
      assert.deepEqual(observedWaits, [40]);
      assert.equal(startSettled, false, "client must remain pending at the TERM grace boundary");
      const messages = await waitForWire(
        fake.logPath,
        (wire) => wire.some((item) => item._fakeEvent === "sigterm")
      );
      assert.ok(
        messages.findIndex((item) => item._fakeEvent === "sigterm") >
          messages.findIndex((item) => item.method === "initialize"),
        "TERM must follow the failed initialize request"
      );
      assert.equal(startSettled, false, "client must not escalate before the grace boundary is released");
      releaseGraceBoundary?.();
    }

    const result = await startResult;
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("initialize unexpectedly succeeded");
    assert.ok(result.error instanceof CodexRpcError && result.error.code === -32099);
    if (process.platform !== "win32") {
      assert.deepEqual(observedWaits, [40, 2_000]);
      assert.equal(childAtGraceBoundary?.signalCode, "SIGKILL", "KILL must follow the released grace boundary");
    }
    assert.equal(client.isReady(), false);
    assert.equal((await client.stop()).alreadyStopped, true);
  } finally {
    releaseGraceBoundary?.();
    restoreWaitForExit();
    await startResult;
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("public exit is emitted only after trailing stdout notifications drain", async () => {
  const fake = await fakeServer("tail-exit");
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, fake.options);
  const order: string[] = [];
  client.on("notification", (message) => {
    if (message.method === "turn/completed") order.push("notification");
  });
  client.on("exit", () => order.push("exit"));
  try {
    await client.ensureStarted();
    const exited = once(client, "exit");
    client.notify("test/emit-tail", {});
    const deadline = Date.now() + 2_000;
    while (client.isReady() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(client.isReady(), false, "fake parent process must exit before its inherited stdout closes");
    const restarted = Promise.all([client.ensureStarted(), client.ensureStarted()]);
    await exited;
    await restarted;
    assert.deepEqual(order, ["notification", "exit"]);
    assert.equal(client.connectionCount(), 2);
    assert.equal((await client.stop()).alreadyStopped, false);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("experimental methods require an explicit initialize capability", async () => {
  const client = new CodexAppServerClient("does-not-run", undefined, 100);
  await assert.rejects(client.request("thread/turns/list", {}), /requires explicit experimentalApi capability/);
  assert.equal(client.connectionCount(), 0);
});

test("a mutation timeout quarantines and drains its generation before reconnect", async () => {
  const fake = await fakeServer("mutation-timeout");
  const validated: number[] = [];
  const client = new CodexAppServerClient(process.execPath, undefined, 1_000, {
    ...fake.options,
    shutdownTimeoutMs: 120,
    killTimeoutMs: 2_000,
    validateProtocolBinding: (generation) => {
      validated.push(generation);
      return protocolBinding(`fake-${generation}`);
    }
  });
  let unhandled = 0;
  client.on("unhandled", () => { unhandled += 1; });
  try {
    await client.ensureStarted();
    assert.equal(client.connectionGeneration(), 1);
    assert.equal(client.connectionProtocolBinding()?.connectionGeneration, 1);
    await assert.rejects(
      client.request("thread/start", {}),
      (error: unknown) => error instanceof CodexConnectionPoisonedError && error.generation === 1
    );
    assert.equal(client.isReady(), false);
    await client.drainBarrier();
    assert.equal(unhandled, 0, "a late mutation response must not re-enter the live generation");

    const account = await client.request("account/read", {});
    assert.equal(account.authMode, "test");
    assert.equal(client.connectionGeneration(), 2);
    assert.equal(client.connectionProtocolBinding()?.version, "fake-2");
    assert.deepEqual(validated, [1, 2]);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("malformed JSONL immediately clears readiness and cannot survive reconnect", async () => {
  const fake = await fakeServer();
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, fake.options);
  try {
    await client.ensureStarted();
    const protocolError = once(client, "protocolError");
    client.notify("test/emit-malformed", {});
    await protocolError;
    assert.equal(client.isReady(), false);

    const account = await client.request("account/read", {});
    assert.equal(account.authMode, "test");
    assert.equal(client.connectionCount(), 2);
    assert.equal(client.connectionGeneration(), 2);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("stop waits for both process exit and inherited stdout closure", async () => {
  const fake = await fakeServer("tail-exit");
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, fake.options);
  try {
    await client.ensureStarted();
    client.notify("test/emit-tail", {});
    const deadline = Date.now() + 2_000;
    while (client.isReady() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(client.isReady(), false);

    let stopped = false;
    const stopping = client.stop().then((result) => {
      stopped = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopped, false, "stdout inherited by the tail writer is still open");
    await stopping;
    assert.equal(stopped, true);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("a delivered mutation with a failed write callback is treated as ambiguous", async () => {
  const fake = await fakeServer("write-ambiguous");
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, fake.options);
  try {
    await client.ensureStarted();
    const restore = injectDeliveredWriteFailure(
      client,
      (message) => message.method === "thread/start",
      async () => { await waitForWire(fake.logPath, (wire) => wire.some((item) => item.method === "thread/start")); }
    );
    await assert.rejects(
      client.request("thread/start", {}),
      (error: unknown) => error instanceof CodexConnectionPoisonedError &&
        /mutation write outcome is ambiguous/.test(error.message)
    );
    restore();
    assert.equal(client.isReady(), false);
    await client.drainBarrier();

    const account = await client.request("account/read", {});
    assert.equal(account.authMode, "test");
    assert.equal(client.connectionGeneration(), 2);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("an approval response write failure poisons the connection", async () => {
  const fake = await fakeServer();
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, fake.options);
  try {
    const serverRequest = once(client, "serverRequest");
    await client.ensureStarted();
    const [request] = await serverRequest;
    const restore = injectDeliveredWriteFailure(
      client,
      (message) => message.id === request.id && "result" in message,
      async () => { await waitForWire(fake.logPath, (wire) => wire.some((item) => item.id === request.id)); }
    );
    let error: unknown;
    try {
      await client.respond(request.id, { decision: "decline" });
      assert.fail("approval response write failure must reject");
    } catch (caught) {
      error = caught;
    }
    restore();
    assert.ok(error instanceof CodexConnectionPoisonedError);
    assert.match(error.message, /server request response.*ambiguous/);
    assert.equal(client.isReady(), false);
    await client.drainBarrier();

    const account = await client.request("account/read", {});
    assert.equal(account.authMode, "test");
    assert.equal(client.connectionGeneration(), 2);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("a notification write failure is fire-and-forget but still poisons the connection", async () => {
  const fake = await fakeServer();
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, fake.options);
  try {
    await client.ensureStarted();
    const restore = injectDeliveredWriteFailure(
      client,
      (message) => message.method === "test/notify-write-failure",
      async () => {
        await waitForWire(
          fake.logPath,
          (wire) => wire.some((item) => item.method === "test/notify-write-failure")
        );
      }
    );
    const processError = once(client, "processError");
    client.notify("test/notify-write-failure", {});
    const [error] = await processError;
    restore();
    assert.ok(error instanceof CodexConnectionPoisonedError);
    assert.equal(client.isReady(), false);
    await client.drainBarrier();

    const account = await client.request("account/read", {});
    assert.equal(account.authMode, "test");
    assert.equal(client.connectionGeneration(), 2);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("an overlong stdout JSONL line is bounded and poisons the connection", async () => {
  const fake = await fakeServer();
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, {
    ...fake.options,
    maxStdoutLineBytes: 256
  });
  try {
    await client.ensureStarted();
    const protocolError = once(client, "protocolError");
    client.notify("test/emit-overlong-json", {});
    const [error] = await protocolError;
    assert.match(String(error), /exceeds 256 bytes/);
    assert.equal(client.isReady(), false);
    await client.drainBarrier();

    const account = await client.request("account/read", {});
    assert.equal(account.authMode, "test");
    assert.equal(client.connectionGeneration(), 2);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("stderr lines are truncated without accumulating or poisoning the protocol", async () => {
  const fake = await fakeServer();
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, {
    ...fake.options,
    maxStderrLineBytes: 32
  });
  const lines: string[] = [];
  try {
    await client.ensureStarted();
    const after = new Promise<void>((resolve) => {
      client.on("stderr", (line) => {
        lines.push(line);
        if (line === "after-truncation") resolve();
      });
    });
    client.notify("test/emit-overlong-stderr", {});
    await after;
    assert.equal(lines[0], `${"s".repeat(32)}\u2026[truncated at 32 bytes]`);
    assert.deepEqual(lines.slice(-1), ["after-truncation"]);
    assert.equal(client.isReady(), true);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});

test("a child error after spawn terminates and drains the still-live process", async () => {
  const fake = await fakeServer();
  const client = new CodexAppServerClient(process.execPath, undefined, 2_000, fake.options);
  try {
    await client.ensureStarted();
    const child = (client as unknown as { child: NodeJS.EventEmitter }).child;
    assert.ok(child);
    const processError = once(client, "processError");
    child.emit("error", new Error("injected live child error"));
    await processError;
    assert.equal(client.isReady(), false);
    await client.drainBarrier();

    const account = await client.request("account/read", {});
    assert.equal(account.authMode, "test");
    assert.equal(client.connectionGeneration(), 2);
  } finally {
    await client.stop().catch(() => undefined);
    await fake.cleanup();
  }
});
