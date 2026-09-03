type WorkerResult = { id: string; vectors?: number[][]; error?: string };

let worker: Worker | undefined;
let queued = Promise.resolve();
const pending = new Map<string, { resolve: (vectors: number[][]) => void; reject: (error: Error) => void }>();

function embeddingWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./local-embeddings-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.vectors ?? []);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "Local embedding worker stopped unexpectedly.");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker = undefined;
  };
  return worker;
}

export async function embedLocally(inputs: string[]) {
  if (!inputs.length) return [];
  const task = queued.then(() => new Promise<number[][]>((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    embeddingWorker().postMessage({ id, inputs });
  }));
  queued = task.then(() => undefined, () => undefined);
  return task;
}
