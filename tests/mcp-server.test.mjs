import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const bun = process.execPath;
const repository = { id: "a9a9d38d-c00b-4a9d-88a2-6880fd70a606", owner: "inputforge", name: "agentforge", default_branch: "main", indexed_sha: "abc123", status: "ready", created_at: "2026-08-22T00:00:00.000Z" };

test("Codewiki MCP exposes tools and returns grounded answers", async (t) => {
  const api = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/repositories") return response.end(JSON.stringify([repository]));
    if (request.method === "POST" && request.url === `/api/repositories/${repository.id}/questions`) return response.end(JSON.stringify({ answer: "AgentForge delegates sandbox creation to sandboxctl. [0]", citations: [{ path: "src/sandbox.ts", startLine: 12, endLine: 31, chunkId: "chunk-1" }] }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());
  const address = api.address();
  assert.ok(address && typeof address === "object");

  const environment = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: bun, args: ["run", "src/mcp/server.ts"], cwd: root, env: { ...environment, CODEWIKI_API_ORIGIN: `http://127.0.0.1:${address.port}/api` }, stderr: "pipe" });
  const client = new Client({ name: "codewiki-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["ask_question", "check_repository", "discover_repositories", "get_repository_overview", "get_repository_status", "import_repository", "list_repositories"]);

  const answer = await client.callTool({ name: "ask_question", arguments: { repository: "inputforge/agentforge", question: "How is a sandbox created?" } });
  assert.equal(answer.isError, undefined);
  assert.equal(answer.structuredContent.repository, "inputforge/agentforge");
  assert.match(answer.structuredContent.answer, /sandboxctl/);
  assert.deepEqual(answer.structuredContent.citations[0], { repository: "inputforge/agentforge", path: "src/sandbox.ts", startLine: 12, endLine: 31, chunkId: "chunk-1" });
});
