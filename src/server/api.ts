import { z } from "zod";
import { aiStatus, saveOpenAIApiKey, startClaudeLogin, startCodexLogin } from "./ai.js";
import { githubAuthStatus, listAccessibleRepositories, readRepository, readViewer, startGitHubCliLogin } from "./github.js";
import { enqueue, enqueueAll, resumeInterruptedJobs, startNightlyScheduler } from "./jobs.js";
import { answerQuestion } from "./knowledge.js";
import { getText } from "./store.js";
import { initializeState, mutateState, readSnapshotIndex, readState } from "./state.js";

const repoInput = z.object({ owner: z.string().regex(/^[\w.-]+$/), name: z.string().regex(/^[\w.-]+$/) });
const repositoryId = (value: string) => z.string().uuid().parse(value);

await initializeState();
await resumeInterruptedJobs();
startNightlyScheduler();

function json(value: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: status === 204 ? {} : { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown server error.";
  const status = error instanceof z.ZodError ? 400 : 500;
  return json({ error: message }, status);
}

export async function handleApi(request: Request, pathname: string): Promise<Response> {
  try {
    if (request.method === "GET" && pathname === "/health") return json({ ok: true, mode: "local-filesystem" });
    if (request.method === "GET" && pathname === "/repositories") return json((await readState()).repositories.sort((left, right) => right.created_at.localeCompare(left.created_at)));
    if (request.method === "GET" && pathname === "/github/auth") return json(await githubAuthStatus());
    if (request.method === "GET" && pathname === "/ai/status") return json(await aiStatus());

    if (request.method === "POST" && pathname === "/ai/claude/login") {
      try { return json(await startClaudeLogin(), 202); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "Claude sign-in could not be started." }, 503); }
    }
    if (request.method === "POST" && pathname === "/ai/codex/login") {
      try { return json(await startCodexLogin(), 202); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "Codex sign-in could not be started." }, 503); }
    }
    if (request.method === "PUT" && pathname === "/ai/openai-key") {
      try {
        const { apiKey } = z.object({ apiKey: z.string() }).parse(await request.json());
        await saveOpenAIApiKey(apiKey);
        return json(null, 204);
      } catch (error) { return json({ error: error instanceof Error ? error.message : "OpenAI API key could not be saved." }, 400); }
    }
    if (request.method === "POST" && pathname === "/github/auth/login") {
      try { return json(await startGitHubCliLogin(), 202); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "GitHub sign-in could not be started." }, 503); }
    }
    if (request.method === "GET" && pathname === "/github/repositories") {
      const [viewer, repositories, state] = await Promise.all([readViewer(), listAccessibleRepositories(), readState()]);
      return json({ viewer, repositories: repositories.map((repository) => {
        const imported = state.repositories.find((record) => record.owner.toLowerCase() === repository.owner.toLowerCase() && record.name.toLowerCase() === repository.name.toLowerCase());
        return { ...repository, importedRepositoryId: imported?.id ?? null, importStatus: imported?.status ?? null };
      }) });
    }
    if (request.method === "POST" && pathname === "/repositories") {
      const input = repoInput.parse(await request.json());
      const github = await readRepository(input.owner, input.name);
      const repository = await mutateState((state) => {
        let record = state.repositories.find((item) => item.owner === input.owner && item.name === input.name);
        if (!record) {
          record = { id: crypto.randomUUID(), owner: input.owner, name: input.name, default_branch: github.default_branch, indexed_sha: null, status: "queued" as const, created_at: new Date().toISOString() };
          state.repositories.push(record);
        } else { record.default_branch = github.default_branch; record.status = "queued"; }
        return record;
      });
      await enqueue({ repositoryId: repository.id, targetSha: "default-branch", trigger: "initial-import", idempotencyKey: `import:${repository.id}:${Date.now()}` });
      return json(repository, 202);
    }
    if (request.method === "POST" && pathname === "/maintenance/nightly") return json({ queued: await enqueueAll() });

    const importMatch = pathname.match(/^\/repositories\/([^/]+)\/import$/);
    if (request.method === "POST" && importMatch) {
      const id = repositoryId(importMatch[1]);
      const repository = (await readState()).repositories.find((item) => item.id === id);
      if (!repository) return json({ error: "Repository not found." }, 404);
      await mutateState((state) => { const current = state.repositories.find((item) => item.id === id); if (current) current.status = "queued"; });
      await enqueue({ repositoryId: id, targetSha: "default-branch", trigger: "initial-import", idempotencyKey: `import:${id}:${Date.now()}` });
      return json({ repositoryId: id, status: "queued" }, 202);
    }
    const questionsMatch = pathname.match(/^\/repositories\/([^/]+)\/questions$/);
    if (request.method === "POST" && questionsMatch) {
      const id = repositoryId(questionsMatch[1]);
      const { question } = z.object({ question: z.string().min(3).max(5000) }).parse(await request.json());
      return json(await answerQuestion(id, question));
    }
    const runsMatch = pathname.match(/^\/repositories\/([^/]+)\/runs$/);
    if (request.method === "GET" && runsMatch) {
      const id = repositoryId(runsMatch[1]);
      return json((await readState()).syncRuns.filter((run) => run.repository_id === id).sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, 30));
    }
    const rollbackMatch = pathname.match(/^\/repositories\/([^/]+)\/pages\/([^/]+)\/rollback$/);
    if (request.method === "POST" && rollbackMatch) {
      const [id, slug] = rollbackMatch.slice(1).map(decodeURIComponent);
      const { revisionId } = z.object({ revisionId: z.string().uuid() }).parse(await request.json());
      const restored = await mutateState((state) => {
        const page = state.wikiPages.find((item) => item.repository_id === id && item.slug === slug);
        if (!page || !state.wikiRevisions.some((revision) => revision.id === revisionId && revision.page_id === page.id)) return false;
        page.current_revision_id = revisionId;
        return true;
      });
      return restored ? json({ restoredRevisionId: revisionId }) : json({ error: "Wiki page not found." }, 404);
    }
    const revisionsMatch = pathname.match(/^\/repositories\/([^/]+)\/pages\/([^/]+)\/revisions$/);
    if (request.method === "GET" && revisionsMatch) {
      const [id, slug] = revisionsMatch.slice(1).map(decodeURIComponent);
      const state = await readState();
      const page = state.wikiPages.find((item) => item.repository_id === id && item.slug === slug);
      return json(page ? state.wikiRevisions.filter((revision) => revision.page_id === page.id).sort((left, right) => right.created_at.localeCompare(left.created_at)) : []);
    }
    const pageMatch = pathname.match(/^\/repositories\/([^/]+)\/pages\/([^/]+)$/);
    if (request.method === "GET" && pageMatch) {
      const [id, slug] = pageMatch.slice(1).map(decodeURIComponent);
      const state = await readState();
      const page = state.wikiPages.find((item) => item.repository_id === id && item.slug === slug);
      const revision = page ? state.wikiRevisions.find((item) => item.id === page.current_revision_id) : undefined;
      if (!page || !revision) return json({ error: "Wiki page not found." }, 404);
      const snapshot = state.snapshots.find((item) => item.id === revision.snapshot_id);
      const index = snapshot ? await readSnapshotIndex(id, snapshot.sha) : null;
      const citedIds = new Set(state.wikiCitations.filter((item) => item.revision_id === revision.id).map((item) => item.chunk_id));
      const citations = (index?.chunks ?? []).filter((chunk) => citedIds.has(chunk.id)).map((chunk) => ({ path: chunk.path, start_line: chunk.startLine, end_line: chunk.endLine }));
      return json({ id: page.id, slug: page.slug, title: page.title, revision_id: revision.id, summary: revision.summary, markdown: await getText(revision.object_key), created_at: revision.created_at, citations });
    }
    const pagesMatch = pathname.match(/^\/repositories\/([^/]+)\/pages$/);
    if (request.method === "GET" && pagesMatch) {
      const id = repositoryId(pagesMatch[1]);
      const state = await readState();
      return json(state.wikiPages.filter((page) => page.repository_id === id).map((page) => {
        const revision = state.wikiRevisions.find((item) => item.id === page.current_revision_id);
        return { id: page.id, slug: page.slug, title: page.title, summary: revision?.summary ?? null, created_at: revision?.created_at ?? null };
      }).sort((left, right) => left.title.localeCompare(right.title)));
    }
    const repositoryMatch = pathname.match(/^\/repositories\/([^/]+)$/);
    if (request.method === "GET" && repositoryMatch) {
      const id = repositoryId(repositoryMatch[1]);
      const repository = (await readState()).repositories.find((item) => item.id === id);
      return repository ? json(repository) : json({ error: "Repository not found." }, 404);
    }
    return json({ error: "Not found" }, 404);
  } catch (error) { return errorResponse(error); }
}
