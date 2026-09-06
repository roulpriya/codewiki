import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds a Bun-served React application", async () => {
  const [client, css, server, home, discover] = await Promise.all([
    readFile(new URL("../dist/web/client.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/web/client.css", import.meta.url), "utf8"),
    readFile(new URL("../src/web.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/discover/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(client, /createRoot/);
  assert.match(home, /Your repositories/);
  assert.match(discover, /Choose what Codewiki should understand/i);
  assert.match(discover, /Search by name or description/i);
  assert.match(css, /--bg:/);
  assert.match(server, /Bun\.serve/);
  assert.match(server, /handleApi/);
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
  assert.doesNotMatch(`${compose}\n${dockerfile}\n${packageJson}`, /postgres|redis|bullmq|minio|drizzle/i);
  await assert.rejects(access(new URL("../src/app/_sites-preview", import.meta.url)));
});
