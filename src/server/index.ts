import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { githubAuthStatus, listAccessibleRepositories, readRepository, readViewer, startGitHubCliLogin } from "./github.js";
import { enqueue, enqueueAll, resumeInterruptedJobs, startNightlyScheduler } from "./jobs.js";
import { answerQuestion } from "./knowledge.js";
import { getText } from "./store.js";
import { initializeState, mutateState, readSnapshotIndex, readState } from "./state.js";

const app = Fastify({ logger: true });
await initializeState();

const repoInput = z.object({ owner: z.string().regex(/^[\w.-]+$/), name: z.string().regex(/^[\w.-]+$/) });
const repositoryId = (value: string) => z.string().uuid().parse(value);

app.get("/health", async () => ({ ok: true, mode: "local-filesystem" }));

app.get("/repositories", async () => (await readState()).repositories.sort((left, right) => right.created_at.localeCompare(left.created_at)));

app.get("/github/auth", async () => githubAuthStatus());

app.post("/github/auth/login", async (_request, reply) => {
  try {
    return reply.code(202).send(await startGitHubCliLogin());
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : "GitHub sign-in could not be started." });
  }
});

app.get("/github/repositories", async () => {
  const [viewer, repositories, state] = await Promise.all([readViewer(), listAccessibleRepositories(), readState()]);
  return {
    viewer,
    repositories: repositories.map((repository) => {
      const imported = state.repositories.find((record) => record.owner.toLowerCase() === repository.owner.toLowerCase() && record.name.toLowerCase() === repository.name.toLowerCase());
      return { ...repository, importedRepositoryId: imported?.id ?? null, importStatus: imported?.status ?? null };
    }),
  };
});

app.post("/repositories", async (request, reply) => {
  const input = repoInput.parse(request.body);
  const github = await readRepository(input.owner, input.name);
  const repository = await mutateState((state) => {
    let record = state.repositories.find((item) => item.owner === input.owner && item.name === input.name);
    if (!record) {
      record = { id: crypto.randomUUID(), owner: input.owner, name: input.name, default_branch: github.default_branch, indexed_sha: null, status: "queued", created_at: new Date().toISOString() };
      state.repositories.push(record);
    } else {
      record.default_branch = github.default_branch;
      record.status = "queued";
    }
    return record;
  });
  await enqueue({ repositoryId: repository.id, targetSha: "default-branch", trigger: "initial-import", idempotencyKey: `import:${repository.id}:${Date.now()}` });
  return reply.code(202).send(repository);
});

app.post("/repositories/:id/import", async (request, reply) => {
  const id = repositoryId((request.params as { id: string }).id);
  const repository = (await readState()).repositories.find((item) => item.id === id);
  if (!repository) return reply.code(404).send({ error: "Repository not found." });
  await mutateState((state) => { const current = state.repositories.find((item) => item.id === id); if (current) current.status = "queued"; });
  await enqueue({ repositoryId: id, targetSha: "default-branch", trigger: "initial-import", idempotencyKey: `import:${id}:${Date.now()}` });
  return reply.code(202).send({ repositoryId: id, status: "queued" });
});

app.get("/repositories/:id", async (request, reply) => {
  const id = repositoryId((request.params as { id: string }).id);
  return (await readState()).repositories.find((item) => item.id === id) ?? reply.code(404).send({ error: "Repository not found." });
});

app.get("/repositories/:id/pages", async (request) => {
  const id = repositoryId((request.params as { id: string }).id);
  const state = await readState();
  return state.wikiPages.filter((page) => page.repository_id === id).map((page) => {
    const revision = state.wikiRevisions.find((item) => item.id === page.current_revision_id);
    return { id: page.id, slug: page.slug, title: page.title, summary: revision?.summary ?? null, created_at: revision?.created_at ?? null };
  }).sort((left, right) => left.title.localeCompare(right.title));
});

app.get("/repositories/:id/pages/:slug", async (request, reply) => {
  const { id, slug } = request.params as { id: string; slug: string };
  const state = await readState();
  const page = state.wikiPages.find((item) => item.repository_id === id && item.slug === slug);
  const revision = page ? state.wikiRevisions.find((item) => item.id === page.current_revision_id) : undefined;
  if (!page || !revision) return reply.code(404).send({ error: "Wiki page not found." });
  const snapshot = state.snapshots.find((item) => item.id === revision.snapshot_id);
  const index = snapshot ? await readSnapshotIndex(id, snapshot.sha) : null;
  const citedIds = new Set(state.wikiCitations.filter((item) => item.revision_id === revision.id).map((item) => item.chunk_id));
  const citations = (index?.chunks ?? []).filter((chunk) => citedIds.has(chunk.id)).map((chunk) => ({ path: chunk.path, start_line: chunk.startLine, end_line: chunk.endLine }));
  return { id: page.id, slug: page.slug, title: page.title, revision_id: revision.id, summary: revision.summary, markdown: await getText(revision.object_key), created_at: revision.created_at, citations };
});

app.get("/repositories/:id/pages/:slug/revisions", async (request) => {
  const { id, slug } = request.params as { id: string; slug: string };
  const state = await readState();
  const page = state.wikiPages.find((item) => item.repository_id === id && item.slug === slug);
  return page ? state.wikiRevisions.filter((revision) => revision.page_id === page.id).sort((left, right) => right.created_at.localeCompare(left.created_at)) : [];
});

app.post("/repositories/:id/pages/:slug/rollback", async (request, reply) => {
  const { id, slug } = request.params as { id: string; slug: string };
  const { revisionId } = z.object({ revisionId: z.string().uuid() }).parse(request.body);
  const restored = await mutateState((state) => {
    const page = state.wikiPages.find((item) => item.repository_id === id && item.slug === slug);
    if (!page || !state.wikiRevisions.some((revision) => revision.id === revisionId && revision.page_id === page.id)) return false;
    page.current_revision_id = revisionId;
    return true;
  });
  return restored ? { restoredRevisionId: revisionId } : reply.code(404).send({ error: "Revision not found." });
});

app.post("/repositories/:id/questions", async (request) => {
  const id = repositoryId((request.params as { id: string }).id);
  const { question } = z.object({ question: z.string().min(3).max(5000) }).parse(request.body);
  return answerQuestion(id, question);
});

app.get("/repositories/:id/runs", async (request) => {
  const id = repositoryId((request.params as { id: string }).id);
  return (await readState()).syncRuns.filter((run) => run.repository_id === id).sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, 30);
});

app.post("/maintenance/nightly", async () => ({ queued: await enqueueAll() }));

await resumeInterruptedJobs();
startNightlyScheduler();
await app.listen({ host: "0.0.0.0", port: config.API_PORT });
