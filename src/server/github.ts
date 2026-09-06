import { config } from "./config.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

type GitHubFile = { path: string; sha: string; content: string };
export type GitHubViewer = { login: string; name: string | null; avatarUrl: string; htmlUrl: string };
export type AccessibleRepository = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  htmlUrl: string;
  language: string | null;
  stars: number;
  updatedAt: string;
  defaultBranch: string;
};
const api = "https://api.github.com";
const excluded = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git)\/|\.(png|jpe?g|gif|pdf|zip|lock)$/i;
const execFileAsync = promisify(execFile);

export type GitHubAuthStatus = {
  authenticated: boolean;
  source: "environment" | "gh" | null;
  message: string;
};

let cachedGhToken: { value: string; expiresAt: number } | null = null;
let loginInProgress = false;

async function readGhToken(): Promise<string | null> {
  if (cachedGhToken && cachedGhToken.expiresAt > Date.now()) return cachedGhToken.value;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: 5_000,
      windowsHide: true,
    });
    const token = stdout.trim();
    if (!token) return null;
    cachedGhToken = { value: token, expiresAt: Date.now() + 60_000 };
    return token;
  } catch {
    return null;
  }
}

async function accessToken(): Promise<{ token: string; source: "environment" | "gh" }> {
  if (config.GITHUB_TOKEN) return { token: config.GITHUB_TOKEN, source: "environment" };
  const token = await readGhToken();
  if (token) return { token, source: "gh" };
  throw new Error("GitHub is not connected. Set GITHUB_TOKEN or sign in with `gh auth login`.");
}

export async function githubAuthStatus(): Promise<GitHubAuthStatus> {
  if (config.GITHUB_TOKEN) return { authenticated: true, source: "environment", message: "Using GITHUB_TOKEN." };
  if (await readGhToken()) return { authenticated: true, source: "gh", message: "Using your GitHub CLI session." };
  return { authenticated: false, source: null, message: "Sign in with GitHub CLI to browse repositories." };
}

export async function startGitHubCliLogin() {
  if (config.GITHUB_TOKEN) return { started: false, message: "GITHUB_TOKEN is already configured." };
  if (await readGhToken()) return { started: false, message: "GitHub CLI is already connected." };
  if (loginInProgress) return { started: false, message: "GitHub CLI sign-in is already open in your browser." };
  try {
    await execFileAsync("gh", ["--version"], { timeout: 5_000, windowsHide: true });
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    loginInProgress = true;
    child.once("exit", () => {
      cachedGhToken = null;
      loginInProgress = false;
    });
    child.once("error", () => {
      loginInProgress = false;
    });
    return { started: true, message: "GitHub CLI opened a browser window for sign-in." };
  } catch {
    throw new Error("GitHub CLI is not installed. Install it from https://cli.github.com/, then run `gh auth login`.");
  }
}

async function request<T>(path: string): Promise<T> {
  const { token } = await accessToken();
  const response = await fetch(`${api}${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

export async function readRepository(owner: string, name: string) {
  return request<{ default_branch: string }>(`/repos/${owner}/${name}`);
}
export async function readViewer(): Promise<GitHubViewer> {
  const viewer = await request<{ login: string; name: string | null; avatar_url: string; html_url: string }>("/user");
  return { login: viewer.login, name: viewer.name, avatarUrl: viewer.avatar_url, htmlUrl: viewer.html_url };
}
export async function listAccessibleRepositories(): Promise<AccessibleRepository[]> {
  type GitHubRepository = {
    id: number;
    owner: { login: string };
    name: string;
    full_name: string;
    description: string | null;
    private: boolean;
    fork: boolean;
    archived: boolean;
    html_url: string;
    language: string | null;
    stargazers_count: number;
    updated_at: string;
    default_branch: string;
  };
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const records = await request<GitHubRepository[]>(`/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=updated&direction=desc&per_page=100&page=${page}`);
    repositories.push(...records);
    if (records.length < 100) break;
  }
  return repositories.map((repository) => ({
    id: repository.id,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    description: repository.description,
    private: repository.private,
    fork: repository.fork,
    archived: repository.archived,
    htmlUrl: repository.html_url,
    language: repository.language,
    stars: repository.stargazers_count,
    updatedAt: repository.updated_at,
    defaultBranch: repository.default_branch,
  }));
}
function checkoutPath(owner: string, name: string) {
  const id = createHash("sha256").update(`${owner.toLowerCase()}/${name.toLowerCase()}`).digest("hex");
  return join(config.REPOSITORY_CACHE_DIR, id);
}

async function gitEnvironment() {
  const { token } = await accessToken();
  // Keep the credential out of the remote URL and command-line arguments.
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

async function git(args: string[], environment: NodeJS.ProcessEnv) {
  try {
    return await execFileAsync("git", args, { env: environment, timeout: 120_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Git checkout failed: ${error instanceof Error ? error.message : "Unknown Git error"}`);
  }
}

async function hasCheckout(path: string, environment: NodeJS.ProcessEnv) {
  try {
    await git(["-C", path, "rev-parse", "--is-inside-work-tree"], environment);
    return true;
  } catch {
    return false;
  }
}

async function updateCheckout(owner: string, name: string, ref: string) {
  const path = checkoutPath(owner, name);
  const environment = await gitEnvironment();
  const remote = `https://github.com/${owner}/${name}.git`;
  if (!await hasCheckout(path, environment)) {
    await rm(path, { recursive: true, force: true });
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
    try {
      await git(["clone", "--depth", "1", "--no-tags", "--branch", ref, remote, temporaryPath], environment);
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  } else {
    await git(["-C", path, "fetch", "--depth", "1", "--no-tags", "origin", ref], environment);
    await git(["-C", path, "checkout", "--detach", "--force", "FETCH_HEAD"], environment);
  }
  return path;
}

async function trackedFiles(path: string): Promise<GitHubFile[]> {
  const { stdout } = await execFileAsync("git", ["-C", path, "ls-files", "-s", "-z"], { timeout: 30_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  const files: GitHubFile[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const match = record.match(/^\d+ ([0-9a-f]+) \d+\t(.+)$/);
    if (!match || excluded.test(match[2])) continue;
    const absolutePath = join(path, match[2]);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile() || metadata.size >= 1_000_000) continue;
    files.push({ path: relative(path, absolutePath), sha: match[1], content: await readFile(absolutePath, "utf8") });
    if (files.length === 5000) break;
  }
  return files;
}

export async function snapshotRepository(owner: string, name: string, ref: string): Promise<{ sha: string; files: GitHubFile[] }> {
  const path = await updateCheckout(owner, name, ref);
  const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"], { timeout: 30_000, windowsHide: true });
  return { sha: stdout.trim(), files: await trackedFiles(path) };
}
