import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: handler } = await import(workerUrl.href);
  return handler(new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }));
}

test("server-renders the Codewiki product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Codewiki — repository knowledge, kept current<\/title>/i);
  assert.match(html, /<body[^>]*>/i);
  assert.match(html, /_next\/static\/chunks\/page-/);
  assert.doesNotMatch(html, /PR #184|Mei Kim|Knowledge health|acme\/platform/);
  assert.match(html, /Your repository, explained\./);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/i);
});

test("server-renders repository discovery as a separate page", async () => {
  const response = await render("/discover");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Choose what Codewiki should understand/i);
  assert.match(html, /Search by name or description/i);
  assert.match(html, /Back to wiki/i);
});

test("uses only local filesystem persistence", async () => {
  const [stateStore, compose, packageJson, dockerfile] = await Promise.all([
    readFile(new URL("../src/server/state.ts", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);
  assert.match(stateStore, /state\.json/);
  assert.match(stateStore, /indexes/);
  assert.match(stateStore, /rename\(temporaryPath/);
  assert.match(compose, /codewiki-data:\/data/);
  assert.doesNotMatch(`${compose}\n${dockerfile}\n${packageJson}`, /postgres|redis|bullmq|pgvector|minio|drizzle/i);
  await assert.rejects(access(new URL("../src/app/_sites-preview", import.meta.url)));
});
