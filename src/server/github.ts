import { config } from "./config.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

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
const blobConcurrency = 4;
const blobRequestSpacingMs = 100;

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

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
      await new Promise((resolve) => setTimeout(resolve, blobRequestSpacingMs));
    }
  }));
  return results;
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
export async function readRepositoryHead(owner: string, name: string, ref: string) {
  return request<{ sha: string }>(`/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`);
}
export async function snapshotRepository(owner: string, name: string, ref: string): Promise<{ sha: string; files: GitHubFile[] }> {
  const commit = await request<{ sha: string; commit: { tree: { sha: string } } }>(`/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`);
  const tree = await request<{ tree: Array<{ path: string; type: string; sha: string; size?: number }> }>(`/repos/${owner}/${name}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  const candidates = tree.tree.filter((entry) => entry.type === "blob" && !excluded.test(entry.path) && (entry.size ?? 0) < 1_000_000).slice(0, 5000);
  const files = await mapWithConcurrency(candidates, blobConcurrency, async (entry) => {
    const blob = await request<{ content: string; encoding: string }>(`/repos/${owner}/${name}/git/blobs/${entry.sha}`);
    return { path: entry.path, sha: entry.sha, content: Buffer.from(blob.content.replace(/\n/g, ""), blob.encoding as BufferEncoding).toString("utf8") };
  });
  return { sha: commit.sha, files };
}
