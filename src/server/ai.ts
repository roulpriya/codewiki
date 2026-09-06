import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const credentialsPath = join(config.DATA_DIR, "ai-credentials.json");
const Credentials = z.object({ openaiApiKey: z.string().min(1).optional() });
let claudeLoginInProgress = false;
let codexLoginInProgress = false;

async function credentials() {
  try { return Credentials.parse(JSON.parse(await readFile(credentialsPath, "utf8"))); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function openAIApiKey() { return config.OPENAI_API_KEY ?? (await credentials()).openaiApiKey; }

export async function saveOpenAIApiKey(openaiApiKey: string) {
  const key = z.string().min(20, "Enter a valid OpenAI API key.").parse(openaiApiKey.trim());
  await mkdir(config.DATA_DIR, { recursive: true });
  const temporaryPath = `${credentialsPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ openaiApiKey: key }), { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, credentialsPath);
}

export async function claudeSubscriptionAvailable() {
  try { await execFileAsync("claude", ["auth", "status", "--text"], { timeout: 5_000, windowsHide: true }); return true; }
  catch { return false; }
}

export async function codexSubscriptionAvailable() {
  try { await execFileAsync("codex", ["login", "status"], { timeout: 5_000, windowsHide: true }); return true; }
  catch { return false; }
}

export async function aiStatus() {
  const [key, claude, codex] = await Promise.all([openAIApiKey(), claudeSubscriptionAvailable(), codexSubscriptionAvailable()]);
  return {
    activeProvider: claude ? "claude" : codex ? "codex" : key ? "openai" : null,
    codex: { available: codex, message: codex ? "Codex is connected through your ChatGPT plan." : "Sign in to Codex with your ChatGPT account." },
    claude: { available: claude, message: claude ? "Claude Code is connected through your subscription." : "Install Claude Code and sign in with an eligible subscription." },
    openai: { available: Boolean(key), source: config.OPENAI_API_KEY ? "environment" : key ? "local" : null },
  };
}

export async function startCodexLogin() {
  if (await codexSubscriptionAvailable()) return { started: false, message: "Codex is already connected." };
  if (codexLoginInProgress) return { started: false, message: "Codex sign-in is already open in your browser." };
  try {
    await execFileAsync("codex", ["--version"], { timeout: 5_000, windowsHide: true });
    const child = spawn("codex", ["login"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    codexLoginInProgress = true;
    child.once("exit", () => { codexLoginInProgress = false; });
    child.once("error", () => { codexLoginInProgress = false; });
    return { started: true, message: "Codex opened a browser window for ChatGPT sign-in." };
  } catch { throw new Error("Codex CLI is not installed. Install or open Codex, then try again."); }
}

export async function startClaudeLogin() {
  if (await claudeSubscriptionAvailable()) return { started: false, message: "Claude Code is already connected." };
  if (claudeLoginInProgress) return { started: false, message: "Claude sign-in is already open in your browser." };
  try {
    await execFileAsync("claude", ["--version"], { timeout: 5_000, windowsHide: true });
    const child = spawn("claude", ["auth", "login"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    claudeLoginInProgress = true;
    child.once("exit", () => { claudeLoginInProgress = false; });
    child.once("error", () => { claudeLoginInProgress = false; });
    return { started: true, message: "Claude Code opened a browser window for sign-in." };
  } catch { throw new Error("Claude Code is not installed. Install it from https://code.claude.com/, then try again."); }
}
