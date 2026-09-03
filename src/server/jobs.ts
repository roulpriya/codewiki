import { config } from "./config.js";
import { readRepositoryHead, snapshotRepository } from "./github.js";
import { authorOverview, hasCurrentEmbeddings, indexSnapshot } from "./knowledge.js";
import { mutateState, readSnapshotIndex, readState } from "./state.js";
import { putJson } from "./store.js";
import { rawImportKey, type IndexJob } from "../lib/wiki-contracts.js";

const activeJobs = new Map<string, Promise<void>>();

export async function enqueue(job: IndexJob) {
  const key = `${job.repositoryId}:${job.targetSha}`;
  if (activeJobs.has(key)) return;
  const operation = processJob(job).finally(() => activeJobs.delete(key));
  activeJobs.set(key, operation);
  void operation.catch((error) => console.error("Codewiki import failed:", error));
}

async function processJob(job: IndexJob) {
  const repository = (await readState()).repositories.find((item) => item.id === job.repositoryId);
  if (!repository) throw new Error("Repository not found.");

  const runId = crypto.randomUUID();
  await mutateState((state) => {
    const current = state.repositories.find((item) => item.id === repository.id);
    if (current) current.status = current.indexed_sha ? "checking" : "running";
    state.syncRuns.push({ id: runId, repository_id: repository.id, kind: job.trigger, status: "running", target_sha: job.targetSha, detail: {}, created_at: new Date().toISOString(), finished_at: null });
  });

  try {
    const ref = job.targetSha === "default-branch" ? repository.default_branch : job.targetSha;
    const head = await readRepositoryHead(repository.owner, repository.name, ref);
    const checkedAt = new Date().toISOString();
    if (repository.indexed_sha === head.sha) {
      const existingIndex = await readSnapshotIndex(repository.id, head.sha);
      if (existingIndex && hasCurrentEmbeddings(existingIndex)) {
        await mutateState((state) => {
          const current = state.repositories.find((item) => item.id === repository.id);
          if (current) { current.status = "ready"; current.last_checked_at = checkedAt; }
          const run = state.syncRuns.find((item) => item.id === runId);
          if (run) { run.status = "completed"; run.detail = { changed: false, chunkCount: existingIndex.chunks.length, sha: head.sha }; run.finished_at = checkedAt; }
        });
        return;
      }
    }

    await mutateState((state) => {
      const current = state.repositories.find((item) => item.id === repository.id);
      if (current) current.status = "running";
    });
    const snapshot = await snapshotRepository(repository.owner, repository.name, head.sha);
    const rawKey = rawImportKey(repository.id, snapshot.sha);
    await putJson(rawKey, { repository: `${repository.owner}/${repository.name}`, sha: snapshot.sha, trigger: job.trigger, capturedAt: new Date().toISOString(), files: snapshot.files });

    const snapshotRecord = await mutateState((state) => {
      let record = state.snapshots.find((item) => item.repository_id === repository.id && item.sha === snapshot.sha);
      if (!record) {
        record = { id: crypto.randomUUID(), repository_id: repository.id, sha: snapshot.sha, trigger: job.trigger, raw_key: rawKey, created_at: new Date().toISOString() };
        state.snapshots.push(record);
      } else {
        record.raw_key = rawKey;
      }
      return record;
    });

    let index = await readSnapshotIndex(repository.id, snapshot.sha);
    if (!index || !hasCurrentEmbeddings(index)) index = await indexSnapshot(repository.id, snapshotRecord.id, snapshot.sha, snapshot.files);
    const alreadyAuthored = (await readState()).wikiRevisions.some((revision) => revision.snapshot_id === snapshotRecord.id);
    if (!alreadyAuthored) await authorOverview(repository.id, snapshotRecord.id, index.chunks);

    await mutateState((state) => {
      const current = state.repositories.find((item) => item.id === repository.id);
      if (current) { current.indexed_sha = snapshot.sha; current.status = "ready"; current.last_checked_at = checkedAt; current.last_synced_at = checkedAt; }
      const run = state.syncRuns.find((item) => item.id === runId);
      if (run) { run.status = "completed"; run.detail = { changed: true, previousSha: repository.indexed_sha, chunkCount: index.chunks.length, sha: snapshot.sha }; run.finished_at = new Date().toISOString(); }
    });
  } catch (error) {
    await mutateState((state) => {
      const current = state.repositories.find((item) => item.id === repository.id);
      if (current) current.status = current.indexed_sha ? "ready" : "failed";
      const run = state.syncRuns.find((item) => item.id === runId);
      if (run) { run.status = "failed"; run.detail = { message: error instanceof Error ? error.message : "Unknown failure" }; run.finished_at = new Date().toISOString(); }
    });
    throw error;
  }
}

export async function enqueueAll(trigger: "nightly-reconcile" = "nightly-reconcile") {
  const repositories = (await readState()).repositories;
  await Promise.all(repositories.map((repository) => enqueue({ repositoryId: repository.id, targetSha: "default-branch", trigger, idempotencyKey: `${trigger}:${repository.id}:${Date.now()}` })));
  return repositories.length;
}

export async function resumeInterruptedJobs() {
  const interrupted = await mutateState((state) => {
    const records = state.repositories.filter((repository) => repository.status === "queued" || repository.status === "checking" || repository.status === "running");
    for (const repository of records) repository.status = "queued";
    for (const run of state.syncRuns.filter((item) => item.status === "running")) {
      run.status = "failed";
      run.detail = { message: "The local process stopped before this import finished." };
      run.finished_at = new Date().toISOString();
    }
    return records.map((repository) => repository.id);
  });
  await Promise.all(interrupted.map((repositoryId) => enqueue({ repositoryId, targetSha: "default-branch", trigger: "initial-import", idempotencyKey: `resume:${repositoryId}` })));
}

export async function enqueueDueRepositories() {
  const intervalMs = config.SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
  const repositories = (await readState()).repositories.filter((repository) => repository.status === "ready" && (!repository.last_checked_at || Date.now() - new Date(repository.last_checked_at).getTime() >= intervalMs));
  await Promise.all(repositories.map((repository) => enqueue({ repositoryId: repository.id, targetSha: "default-branch", trigger: "nightly-reconcile", idempotencyKey: `scheduled:${repository.id}:${Date.now()}` })));
  return repositories.length;
}

export function startNightlyScheduler() {
  void enqueueDueRepositories();
  const checkFrequencyMs = Math.min(config.SYNC_INTERVAL_HOURS * 60 * 60 * 1000, 60 * 60 * 1000);
  const interval = setInterval(() => void enqueueDueRepositories(), checkFrequencyMs);
  interval.unref();
}
