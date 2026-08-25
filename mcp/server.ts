#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type Repository = {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  indexed_sha: string | null;
  status: "idle" | "queued" | "checking" | "running" | "ready" | "failed";
  created_at: string;
  last_checked_at?: string | null;
  last_synced_at?: string | null;
};

type PageSummary = { id: string; slug: string; title: string; summary: string | null; created_at: string | null };
type PageDetail = PageSummary & { markdown: string; citations: Array<{ path: string; start_line: number; end_line: number }> };
type Discovery = {
  viewer: { login: string; name: string | null };
  repositories: Array<{
    owner: string;
    name: string;
    fullName: string;
    description: string | null;
    private: boolean;
    archived: boolean;
    language: string | null;
    updatedAt: string;
    importedRepositoryId: string | null;
    importStatus: Repository["status"] | null;
  }>;
};

const configuredOrigin = process.env.CODEWIKI_API_ORIGIN ?? "http://127.0.0.1:3000/api";
const apiOrigin = configuredOrigin.replace(/\/$/, "");
const parsedOrigin = new URL(apiOrigin);
if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") throw new Error("CODEWIKI_API_ORIGIN must use http or https.");

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Codewiki API request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

async function repositories() {
  return apiRequest<Repository[]>("/repositories");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveRepository(identifier: string) {
  const trimmed = identifier.trim();
  const notImported = () => new Error(`Repository '${identifier}' is not imported. Use discover_repositories or import_repository first.`);
  if (UUID_PATTERN.test(trimmed)) {
    try {
      return await apiRequest<Repository>(`/repositories/${trimmed}`);
    } catch {
      throw notImported();
    }
  }
  const normalized = trimmed.toLowerCase();
  const repository = (await repositories()).find((record) => `${record.owner}/${record.name}`.toLowerCase() === normalized);
  if (!repository) throw notImported();
  return repository;
}

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown Codewiki MCP error.";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const server = new McpServer({ name: "codewiki", version: "0.1.0" }, {
  instructions: `Use Codewiki to answer questions about GitHub repositories from locally indexed, source-cited evidence.

Repository workflow:
1. If the repository is already known by UUID or exact owner/name, use it directly. Otherwise use list_repositories.
2. Use discover_repositories when the requested repository has not been imported.
3. Check repository status before requesting an overview or grounded answer.
4. Imports and update checks are asynchronous. After starting one, report that it is queued and use get_repository_status to follow its progress. Never claim that indexing completed until the status is ready.
5. Treat import_repository and check_repository as operations that can download data, write local state, and incur model usage. Obtain user approval before starting them unless the user explicitly requested that operation.
6. Preserve repository name, file path, and line-range citations in the final answer.
7. Do not supplement an insufficient Codewiki answer with unsupported claims about the repository.
8. Each ask_question call is scoped to exactly one repository.`,
});

server.registerTool("list_repositories", {
  title: "List indexed repositories",
  description: "List repositories already imported into Codewiki, including indexing and synchronization status.",
  inputSchema: {
    status: z.enum(["all", "idle", "queued", "checking", "running", "ready", "failed"]).default("all").describe("Optional repository status filter."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ status }) => {
  try {
    const records = (await repositories()).filter((repository) => status === "all" || repository.status === status);
    return result({ count: records.length, repositories: records.map((repository) => ({ id: repository.id, repository: `${repository.owner}/${repository.name}`, defaultBranch: repository.default_branch, status: repository.status, indexedSha: repository.indexed_sha, lastCheckedAt: repository.last_checked_at ?? null, lastSyncedAt: repository.last_synced_at ?? null })) });
  } catch (error) { return failure(error); }
});

server.registerTool("discover_repositories", {
  title: "Discover GitHub repositories",
  description: "Search repositories visible to Codewiki's configured GitHub token and show whether each is already imported.",
  inputSchema: {
    query: z.string().max(200).default("").describe("Case-insensitive repository name or description search."),
    visibility: z.enum(["all", "public", "private"]).default("all"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ query, visibility, limit }) => {
  try {
    const discovery = await apiRequest<Discovery>("/github/repositories");
    const term = query.trim().toLowerCase();
    const matches = discovery.repositories.filter((repository) => {
      if (visibility === "private" && !repository.private) return false;
      if (visibility === "public" && repository.private) return false;
      return !term || repository.fullName.toLowerCase().includes(term) || repository.description?.toLowerCase().includes(term);
    }).slice(0, limit);
    return result({ account: discovery.viewer.login, count: matches.length, repositories: matches });
  } catch (error) { return failure(error); }
});

server.registerTool("get_repository_status", {
  title: "Get repository status",
  description: "Get indexing and synchronization status for one imported repository.",
  inputSchema: { repository: z.string().min(1).describe("Repository UUID or owner/name, for example inputforge/agentforge.") },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ repository }) => {
  try { return result({ repository: await resolveRepository(repository) }); } catch (error) { return failure(error); }
});

server.registerTool("get_repository_overview", {
  title: "Get repository overview",
  description: "Read the current generated architecture overview and its source citations for an imported repository.",
  inputSchema: { repository: z.string().min(1).describe("Repository UUID or owner/name.") },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ repository: identifier }) => {
  try {
    const repository = await resolveRepository(identifier);
    const pages = await apiRequest<PageSummary[]>(`/repositories/${repository.id}/pages`);
    if (!pages.length) throw new Error(`${repository.owner}/${repository.name} does not have a generated overview yet.`);
    const latest = pages.reduce((newest, candidate) => (candidate.created_at ?? "") > (newest.created_at ?? "") ? candidate : newest);
    const page = await apiRequest<PageDetail>(`/repositories/${repository.id}/pages/${encodeURIComponent(latest.slug)}`);
    return result({ repository: `${repository.owner}/${repository.name}`, title: page.title, summary: page.summary, markdown: page.markdown, createdAt: page.created_at, citations: page.citations });
  } catch (error) { return failure(error); }
});

server.registerTool("ask_question", {
  title: "Ask Codewiki",
  description: "Answer a focused question using the current index for exactly one repository. Returns an evidence-grounded answer and supporting file-and-line citations. It cannot answer from changes newer than the indexed SHA.",
  inputSchema: {
    repository: z.string().min(1).describe("Repository UUID or owner/name, for example inputforge/agentforge."),
    question: z.string().min(3).max(5000).describe("A focused question about the repository."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ repository: identifier, question }) => {
  try {
    const repository = await resolveRepository(identifier);
    const answer = await apiRequest<{ answer: string; citations: Array<{ path: string; startLine: number; endLine: number; chunkId: string }> }>(`/repositories/${repository.id}/questions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
    return result({ repository: `${repository.owner}/${repository.name}`, question, answer: answer.answer, citations: answer.citations.map((citation) => ({ repository: `${repository.owner}/${repository.name}`, ...citation })) });
  } catch (error) { return failure(error); }
});

server.registerTool("import_repository", {
  title: "Import repository",
  description: "Start an asynchronous import of a GitHub repository. This downloads repository content, writes local state, and may incur OpenAI usage. A successful response means the import was queued, not completed.",
  inputSchema: { repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("GitHub owner/name, for example inputforge/agentforge.") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ repository }) => {
  try {
    const [owner, name] = repository.split("/");
    const imported = await apiRequest<Repository>("/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner, name }) });
    return result({ repository: `${imported.owner}/${imported.name}`, repositoryId: imported.id, status: "queued", message: "Import started. Use get_repository_status to follow progress." });
  } catch (error) { return failure(error); }
});

server.registerTool("check_repository", {
  title: "Check repository for updates",
  description: "Asynchronously compare an imported repository's remote default-branch SHA with the indexed SHA. If changed, download, index, and regenerate its wiki. A successful response means the check was queued.",
  inputSchema: { repository: z.string().min(1).describe("Repository UUID or owner/name.") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ repository: identifier }) => {
  try {
    const repository = await resolveRepository(identifier);
    await apiRequest(`/repositories/${repository.id}/import`, { method: "POST" });
    return result({ repository: `${repository.owner}/${repository.name}`, repositoryId: repository.id, status: "queued", message: "Update check started. Use get_repository_status to follow progress." });
  } catch (error) { return failure(error); }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`Codewiki MCP running on stdio; API: ${apiOrigin}`);
}

main().catch((error) => {
  console.error("Codewiki MCP failed:", error);
  process.exit(1);
});
