import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export type RepositoryRecord = {
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

export type SnapshotRecord = {
  id: string;
  repository_id: string;
  sha: string;
  trigger: string;
  raw_key: string;
  created_at: string;
};

export type WikiPageRecord = {
  id: string;
  repository_id: string;
  slug: string;
  title: string;
  current_revision_id: string | null;
};

export type WikiRevisionRecord = {
  id: string;
  page_id: string;
  snapshot_id: string;
  summary: string;
  object_key: string;
  created_at: string;
};

export type WikiCitationRecord = {
  revision_id: string;
  chunk_id: string;
  evidence_index?: number;
};

export type SyncRunRecord = {
  id: string;
  repository_id: string;
  kind: string;
  status: "running" | "completed" | "failed";
  target_sha: string;
  detail: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
};

export type LocalState = {
  repositories: RepositoryRecord[];
  snapshots: SnapshotRecord[];
  wikiPages: WikiPageRecord[];
  wikiRevisions: WikiRevisionRecord[];
  wikiCitations: WikiCitationRecord[];
  syncRuns: SyncRunRecord[];
};

export type IndexChunk = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  embedding: number[] | null;
};

export type SnapshotIndex = {
  repositoryId: string;
  snapshotId: string;
  sha: string;
  embeddingProfile: string;
  chunks: IndexChunk[];
};

const statePath = join(config.DATA_DIR, "state.json");
const indexesRoot = join(config.DATA_DIR, "indexes");
const emptyState = (): LocalState => ({
  repositories: [], snapshots: [], wikiPages: [], wikiRevisions: [],
  wikiCitations: [], syncRuns: [],
});

let mutationChain: Promise<unknown> = Promise.resolve();

async function readStateFile(): Promise<LocalState> {
  await mkdir(config.DATA_DIR, { recursive: true });
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as LocalState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = emptyState();
    await writeStateFile(state);
    return state;
  }
}

async function writeStateFile(state: LocalState) {
  await mkdir(config.DATA_DIR, { recursive: true });
  const temporaryPath = `${statePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  await rename(temporaryPath, statePath);
}

export async function initializeState() {
  await mutateState((state) => {
    for (const repository of state.repositories) {
      repository.last_checked_at ??= null;
      repository.last_synced_at ??= repository.indexed_sha ? repository.created_at : null;
    }
  });
  await mkdir(indexesRoot, { recursive: true });
}

export async function readState() {
  await mutationChain;
  return readStateFile();
}

export async function mutateState<T>(mutator: (state: LocalState) => T | Promise<T>): Promise<T> {
  const operation = mutationChain.then(async () => {
    const state = await readStateFile();
    const result = await mutator(state);
    await writeStateFile(state);
    return result;
  });
  mutationChain = operation.then(() => undefined, () => undefined);
  return operation;
}

function indexPath(repositoryId: string, sha: string) {
  if (!/^[\w-]+$/.test(repositoryId) || !/^[a-f\d]+$/i.test(sha)) {
    throw new Error("Invalid index identifier.");
  }
  return join(indexesRoot, repositoryId, `${sha}.json`);
}

export async function readSnapshotIndex(repositoryId: string, sha: string): Promise<SnapshotIndex | null> {
  try {
    return JSON.parse(await readFile(indexPath(repositoryId, sha), "utf8")) as SnapshotIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeSnapshotIndex(index: SnapshotIndex) {
  const destination = indexPath(index.repositoryId, index.sha);
  await mkdir(join(indexesRoot, index.repositoryId), { recursive: true });
  const temporaryPath = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(index), "utf8");
  await rename(temporaryPath, destination);
}
