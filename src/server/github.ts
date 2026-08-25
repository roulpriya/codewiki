import { config } from "./config.js";

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

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${api}${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${config.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } });
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
export async function readRepositoryHead(owner: string, name: string, ref: string) {
  return request<{ sha: string }>(`/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`);
}
export async function snapshotRepository(owner: string, name: string, ref: string): Promise<{ sha: string; files: GitHubFile[] }> {
  const commit = await request<{ sha: string; commit: { tree: { sha: string } } }>(`/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`);
  const tree = await request<{ tree: Array<{ path: string; type: string; sha: string; size?: number }> }>(`/repos/${owner}/${name}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  const candidates = tree.tree.filter((entry) => entry.type === "blob" && !excluded.test(entry.path) && (entry.size ?? 0) < 1_000_000).slice(0, 5000);
  const files = await Promise.all(candidates.map(async (entry) => {
    const blob = await request<{ content: string; encoding: string }>(`/repos/${owner}/${name}/git/blobs/${entry.sha}`);
    return { path: entry.path, sha: entry.sha, content: Buffer.from(blob.content.replace(/\n/g, ""), blob.encoding as BufferEncoding).toString("utf8") };
  }));
  return { sha: commit.sha, files };
}
