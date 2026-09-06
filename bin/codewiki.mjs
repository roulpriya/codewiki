#!/usr/bin/env node

import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let [command = "start", ...args] = process.argv.slice(2);
if (command === "--help" || command === "-h") command = "help";
if (command === "--version" || command === "-v") {
  const manifest = await import(new URL("../package.json", import.meta.url), { with: { type: "json" } });
  console.log(manifest.default.version);
  process.exit(0);
}
const commands = new Set(["start", "stop", "restart", "status", "logs", "dev", "serve", "web", "api", "mcp", "build", "help"]);

function printHelp() {
  console.log(`Codewiki — a local, source-cited wiki for GitHub repositories

Usage: codewiki <command> [options]

Commands:
  start [Bun options]     Start the production web app and API server as a daemon (default)
  stop                    Stop the local Codewiki daemon
  restart [Bun options]   Restart the local Codewiki daemon
  status                  Show daemon status
  logs                    Print the daemon log
  dev [Bun options]       Run the development web app and API server in the foreground
  web [Bun options]       Run only the production web app
  api                     Run the single web and API server
  mcp                     Ensure the daemon is running, then run the stdio MCP server
  build                   Build the production web app
  help                    Show this help

Environment:
  DATA_DIR                Directory for local Codewiki data
  GITHUB_TOKEN            GitHub token for headless use
  OPENAI_API_KEY          OpenAI API key (optional)

Codewiki requires Bun 1.3.12 or later. See https://github.com/roulpriya/codewiki`);
}

function defaultDataDir() {
  return join(process.cwd(), "data");
}

function runtimeEnv() {
  const env = { ...process.env };
  env.DATA_DIR ??= defaultDataDir();
  return env;
}

function daemonPaths() {
  const directory = join(runtimeEnv().DATA_DIR, "runtime");
  return { directory, pid: join(directory, "codewiki.pid"), log: join(directory, "codewiki.log") };
}

function readPid() {
  try {
    const pid = Number.parseInt(readFileSync(daemonPaths().pid, "utf8"), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePid() {
  try { unlinkSync(daemonPaths().pid); } catch { /* The file is already gone. */ }
}

function ensureProductionBuild() {
  const clientBundle = join(packageRoot, "dist", "web", "client.js");
  const env = runtimeEnv();
  const needsBuild = !existsSync(clientBundle);
  if (!needsBuild) return;

  console.log("Building Codewiki...");
  const result = spawnSync("bun", ["run", "build"], { cwd: packageRoot, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error("Codewiki production build failed.");
    process.exit(result.status ?? 1);
  }
}

function requireBun() {
  const result = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (!result.error && result.status === 0) return;
  console.error("Codewiki requires Bun 1.3.12 or newer. Install it from https://bun.sh.");
  process.exit(1);
}

function runBun(bunArgs, { wait = true } = {}) {
  const child = spawn("bun", bunArgs, { cwd: packageRoot, env: runtimeEnv(), stdio: "inherit" });
  if (!wait) return child;
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  return child;
}

function startDaemon(webArgs, { quiet = false } = {}) {
  ensureProductionBuild();
  const existingPid = readPid();
  if (isRunning(existingPid)) {
    if (!quiet) console.log(`Codewiki is already running (pid ${existingPid}).`);
    return;
  }
  removePid();
  const paths = daemonPaths();
  mkdirSync(paths.directory, { recursive: true });
  const log = openSync(paths.log, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", ...webArgs], {
    cwd: packageRoot,
    detached: true,
    env: runtimeEnv(),
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(paths.pid, `${child.pid}\n`, { mode: 0o600 });
  if (!quiet) console.log(`Codewiki started in the background (pid ${child.pid}). Open http://localhost:3000`);
}

async function stopDaemon({ quiet = false } = {}) {
  const pid = readPid();
  if (!isRunning(pid)) {
    removePid();
    if (!quiet) console.log("Codewiki is not running.");
    return;
  }
  try {
    if (process.platform === "win32") process.kill(pid, "SIGTERM");
    else process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  for (let attempt = 0; attempt < 50 && isRunning(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isRunning(pid)) {
    console.error(`Codewiki (pid ${pid}) did not stop cleanly. See \`codewiki logs\`.`);
    process.exitCode = 1;
    return;
  }
  removePid();
  if (!quiet) console.log("Codewiki stopped.");
}

if (!commands.has(command)) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
if (command === "help") {
  printHelp();
  process.exit(0);
}

requireBun();

if (command === "start") startDaemon(args);
else if (command === "stop") await stopDaemon();
else if (command === "restart") {
  await stopDaemon({ quiet: true });
  startDaemon(args);
} else if (command === "status") {
  const pid = readPid();
  if (isRunning(pid)) console.log(`Codewiki is running (pid ${pid}). Open http://localhost:3000`);
  else {
    removePid();
    console.log("Codewiki is not running.");
    process.exitCode = 1;
  }
} else if (command === "logs") {
  const { log } = daemonPaths();
  if (!existsSync(log)) {
    console.log("No Codewiki daemon log has been created yet.");
  } else {
    const contents = readFileSync(log, "utf8");
    process.stdout.write(contents.slice(-20_000));
  }
} else if (command === "build") runBun(["run", "build", ...args]);
else if (command === "web") runBun(["run", "start", ...args]);
else if (command === "api") runBun(["run", "start"]);
else if (command === "mcp") {
  startDaemon([], { quiet: true });
  runBun(["run", "src/mcp/server.ts"], { wait: true });
}
else {
  const web = runBun(["run", command === "dev" ? "dev" : "start", ...args], { wait: false });
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    web.kill("SIGTERM");
    process.exitCode = code;
  };
  process.on("SIGINT", () => stop());
  process.on("SIGTERM", () => stop());
  for (const child of [web]) {
    child.on("error", (error) => { console.error(error.message); stop(1); });
    child.on("exit", (code) => stop(code ?? 1));
  }
  if (command === "serve") {
    const pid = process.pid;
    process.on("exit", () => { if (readPid() === pid) removePid(); });
  }
}
