import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the Codewiki product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Codewiki — repository knowledge, kept current<\/title>/i);
  assert.match(html, /Import repository/);
  assert.match(html, /Your local code wiki/);
  assert.match(html, /Ask your repository/);
  assert.match(html, /Import a repository to see progress here/);
  assert.doesNotMatch(html, /PR #184|Mei Kim|Knowledge health|acme\/platform/);
  assert.match(html, /Your repository, explained\./);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/i);
});

test("server-renders repository discovery as a separate page", async () => {
  const response = await render("/discover");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Repository discovery/i);
  assert.match(html, /Choose what Codewiki should understand/i);
  assert.match(html, /Search by name or description/i);
  assert.match(html, /Back to wiki/i);
});

test("uses only local filesystem persistence", async () => {
  const [stateStore, compose, packageJson, dockerfile] = await Promise.all([
    readFile(new URL("../server/state.ts", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);
  assert.match(stateStore, /state\.json/);
  assert.match(stateStore, /indexes/);
  assert.match(stateStore, /rename\(temporaryPath/);
  assert.match(compose, /codewiki-data:\/data/);
  assert.doesNotMatch(`${compose}\n${dockerfile}\n${packageJson}`, /postgres|redis|bullmq|pgvector|minio|drizzle/i);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
