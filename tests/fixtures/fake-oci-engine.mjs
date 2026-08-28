import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rawArgv = process.argv.slice(2);
let configuredStateRoot;
let configuredInspectImage;
if (rawArgv[0] === "--state-root" && typeof rawArgv[1] === "string") {
  configuredStateRoot = path.resolve(rawArgv[1]);
  rawArgv.splice(0, 2);
}
if (rawArgv[0] === "--inspect-image" && typeof rawArgv[1] === "string") {
  configuredInspectImage = rawArgv[1];
  rawArgv.splice(0, 2);
}
const argv = rawArgv;
const command = argv[0];
const stateRoot = configuredStateRoot ?? path.join(os.tmpdir(), `codex-supervisor-fake-oci-${process.ppid}`);
fs.mkdirSync(stateRoot, { recursive: true });

function stateFile(id) {
  return path.join(stateRoot, `${id}.json`);
}

function read(id) {
  return JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
}

function write(record) {
  fs.writeFileSync(stateFile(record.id), JSON.stringify(record));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && typeof args[index + 1] === "string") values.push(args[++index]);
  }
  return values;
}

if (command === "version") {
  process.stdout.write("{}\n");
} else if (command === "info") {
  if (argv.includes("{{json .}}")) {
    process.stdout.write(JSON.stringify({
      ID: `fake-docker-${path.basename(stateRoot)}`,
      DockerRootDir: stateRoot,
      Name: "fake-docker"
    }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({
      store: { graphRoot: stateRoot, runRoot: stateRoot, volumePath: path.join(stateRoot, "volumes") },
      host: { id: `fake-podman-${path.basename(stateRoot)}`, hostname: "fake-podman", security: { rootless: true } }
    }) + "\n");
  }
} else if (command === "image" && argv[1] === "inspect") {
  process.stdout.write('[{"Id":"sha256:' + "f".repeat(64) + '"}]\n');
} else if (command === "create") {
  const required = [
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--init",
    "--ipc=none"
  ];
  for (const flag of required) if (!argv.includes(flag)) fail(`missing security flag: ${flag}`);
  for (const option of ["--pids-limit", "--memory", "--cpus", "--user", "--mount", "--tmpfs", "--workdir"]) {
    if (optionValues(argv, option).length !== 1) fail(`missing bounded option: ${option}`);
  }
  const user = optionValues(argv, "--user")[0];
  if (!/^[1-9][0-9]*:[1-9][0-9]*$/.test(user)) fail("root user is forbidden");
  const mount = optionValues(argv, "--mount")[0];
  if (!mount.endsWith(",readonly")) fail("worktree mount is not read-only");
  const imageIndex = argv.findIndex(
    (entry) => !entry.startsWith("io.openai.codex-supervisor.") && /@sha256:[a-f0-9]{64}$/.test(entry)
  );
  if (imageIndex < 0 || !argv[imageIndex + 1]) fail("digest image or recipe program missing");
  const labels = Object.fromEntries(optionValues(argv, "--label").map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const source = mount.match(/(?:^|,)source=([^,]+)/)?.[1];
  if (!source) fail("read-only source mount missing");
  const id = randomBytes(32).toString("hex");
  write({
    id,
    image: argv[imageIndex],
    running: false,
    pid: 0,
    exitCode: 0,
    labels,
    source,
    workdir: optionValues(argv, "--workdir")[0],
    program: argv[imageIndex + 1],
    args: argv.slice(imageIndex + 2)
  });
  process.stdout.write(`${id}\n`);
} else if (command === "start" && argv[1] === "--attach") {
  const record = read(argv[2]);
  record.running = true;
  record.pid = 4242;
  write(record);
  if (record.program === "__FAKE_BACKGROUND__") {
    // Model an engine attach process that exits while a container descendant
    // remains. The Supervisor must inspect, kill and reject this recipe.
    process.exit(0);
  }
  const relative = record.workdir === "/workspace"
    ? ""
    : record.workdir.replace(/^\/workspace\/?/, "");
  const cwd = path.resolve(record.source, relative);
  const child = spawn(record.program, record.args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  record.hostPid = child.pid;
  write(record);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const result = await new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1 }));
    child.once("exit", (code) => resolve({ code: typeof code === "number" ? code : 1 }));
  });
  record.running = false;
  record.pid = 0;
  record.exitCode = result.code;
  delete record.hostPid;
  write(record);
  process.exit(record.exitCode);
} else if (command === "container" && argv[1] === "ls") {
  const requestedLabels = optionValues(argv, "--filter")
    .filter((entry) => entry.startsWith("label="))
    .map((entry) => entry.slice("label=".length));
  const ids = fs.readdirSync(stateRoot)
    .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
    .map((entry) => read(entry.slice(0, -5)))
    .filter((record) => requestedLabels.every((filter) => {
      const separator = filter.indexOf("=");
      const name = separator >= 0 ? filter.slice(0, separator) : filter;
      const value = separator >= 0 ? filter.slice(separator + 1) : undefined;
      return Object.hasOwn(record.labels, name) && (value === undefined || record.labels[name] === value);
    }))
    .map((record) => record.id);
  process.stdout.write(ids.length ? `${ids.join("\n")}\n` : "");
} else if (command === "inspect") {
  const record = read(argv[1]);
  process.stdout.write(JSON.stringify([{
    Id: record.id,
    State: {
      Running: record.running,
      Status: record.running ? "running" : "exited",
      Pid: record.pid,
      ExitCode: record.exitCode
    },
    Config: { Image: configuredInspectImage ?? record.image, Labels: record.labels }
  }]) + "\n");
} else if (command === "kill") {
  const id = argv.at(-1);
  const record = read(id);
  if (Number.isSafeInteger(record.hostPid) && record.hostPid > 1) {
    try {
      process.kill(record.hostPid, "SIGKILL");
    } catch {
      // The simulated root may already have exited.
    }
  }
  record.running = false;
  record.pid = 0;
  record.exitCode = 137;
  delete record.hostPid;
  write(record);
} else if (command === "rm") {
  const id = argv.at(-1);
  const record = read(id);
  if (record.running) fail("cannot remove running container");
  fs.unlinkSync(stateFile(id));
  process.stdout.write(`${id}\n`);
} else {
  fail(`unsupported fake OCI command: ${argv.join(" ")}`);
}
