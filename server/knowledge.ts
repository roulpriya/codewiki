import { createHash } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { config } from "./config.js";
import { mutateState, readSnapshotIndex, readState, writeSnapshotIndex, type IndexChunk } from "./state.js";
import { putText } from "./store.js";
import { wikiRevisionKey } from "../lib/wiki-contracts.js";

const client = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : undefined;
type SourceChunk = { path: string; startLine: number; endLine: number; content: string };
const fileTypes = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "md", "json", "yml", "yaml", "css", "html", "cjs", "mjs"]);

export const isExcluded = (path: string) => /(^|\/)(node_modules|vendor|dist|build|coverage|\.git)\/|\.(png|jpe?g|gif|pdf|zip|lock)$/i.test(path) || /(^|\/)(\.env|.*secret.*|.*credential.*)$/i.test(path);

export function splitFile(path: string, content: string): SourceChunk[] {
  const lines = content.split("\n");
  const chunks: SourceChunk[] = [];
  for (let offset = 0; offset < lines.length; offset += 80) {
    chunks.push({ path, startLine: offset + 1, endLine: Math.min(offset + 80, lines.length), content: lines.slice(offset, offset + 80).join("\n") });
  }
  return chunks.filter((chunk) => chunk.content.trim());
}

async function embeddings(inputs: string[]) {
  if (!client) return inputs.map(() => null);
  const response = await client.embeddings.create({ model: config.OPENAI_EMBEDDING_MODEL, input: inputs });
  return response.data.map((item) => item.embedding);
}

export async function indexSnapshot(repositoryId: string, snapshotId: string, sha: string, files: Array<{ path: string; sha: string; content: string }>) {
  const sourceChunks = files
    .filter((file) => !isExcluded(file.path) && fileTypes.has(file.path.split(".").pop()?.toLowerCase() ?? ""))
    .flatMap((file) => splitFile(file.path, file.content));
  const vectors = await embeddings(sourceChunks.map((chunk) => chunk.content));
  const chunks: IndexChunk[] = sourceChunks.map((chunk, index) => ({
    id: crypto.randomUUID(), ...chunk,
    contentHash: createHash("sha256").update(chunk.content).digest("hex"),
    embedding: vectors[index],
  }));
  const snapshotIndex = { repositoryId, snapshotId, sha, chunks };
  await writeSnapshotIndex(snapshotIndex);
  return snapshotIndex;
}

const Page = z.object({ title: z.string(), slug: z.string(), summary: z.string(), markdown: z.string(), citedChunkIndexes: z.array(z.number().int().nonnegative()) });

export async function authorOverview(repositoryId: string, snapshotId: string, allChunks: IndexChunk[]) {
  const chunks = allChunks.slice(0, 80);
  if (!chunks.length) return;
  const context = chunks.map((chunk, index) => `[${index}] ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n${chunk.content}`).join("\n\n");
  let page: z.infer<typeof Page>;
  if (client) {
    const response = await client.responses.parse({ model: config.OPENAI_GENERATION_MODEL, input: [{ role: "system", content: "Write a precise repository architecture wiki page. Cite only supplied chunks. Return Markdown without a title heading." }, { role: "user", content: context }], text: { format: zodTextFormat(Page, "wiki_page") } });
    if (!response.output_parsed) throw new Error("The wiki author did not return a page.");
    page = response.output_parsed;
  } else {
    page = { title: "Architecture overview", slug: "architecture-overview", summary: "Generated from the indexed repository.", markdown: "## Indexed repository\n\nAdd `OPENAI_API_KEY` to generate narrative documentation.", citedChunkIndexes: chunks.slice(0, 3).map((_, index) => index) };
  }

  const revisionId = crypto.randomUUID();
  const objectKey = wikiRevisionKey(repositoryId, revisionId, page.slug);
  await putText(objectKey, `# ${page.title}\n\n${page.markdown}`);
  await mutateState((state) => {
    let wiki = state.wikiPages.find((item) => item.repository_id === repositoryId && item.slug === page.slug);
    if (!wiki) {
      wiki = { id: crypto.randomUUID(), repository_id: repositoryId, slug: page.slug, title: page.title, current_revision_id: null };
      state.wikiPages.push(wiki);
    } else {
      wiki.title = page.title;
    }
    state.wikiRevisions.push({ id: revisionId, page_id: wiki.id, snapshot_id: snapshotId, summary: page.summary, object_key: objectKey, created_at: new Date().toISOString() });
    wiki.current_revision_id = revisionId;
    for (const index of [...new Set(page.citedChunkIndexes)].filter((value) => value < chunks.length)) {
      state.wikiCitations.push({ revision_id: revisionId, chunk_id: chunks[index].id });
    }
  });
}

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

function lexicalScore(content: string, terms: string[]) {
  const normalized = content.toLowerCase();
  return terms.length ? terms.filter((term) => normalized.includes(term)).length / terms.length : 0;
}

export async function answerQuestion(repositoryId: string, question: string) {
  const repository = (await readState()).repositories.find((item) => item.id === repositoryId);
  if (!repository?.indexed_sha) return { answer: "This repository has not finished indexing.", citations: [] };
  const index = await readSnapshotIndex(repositoryId, repository.indexed_sha);
  if (!index) return { answer: "I do not have enough indexed evidence to answer that question.", citations: [] };

  const [queryVector] = await embeddings([question]);
  const terms = [...new Set(question.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])];
  const rows = index.chunks
    .map((chunk) => ({ chunk, score: 0.35 * lexicalScore(chunk.content, terms) + (queryVector && chunk.embedding ? 0.65 * cosineSimilarity(queryVector, chunk.embedding) : 0) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((row) => row.chunk);
  if (!rows.length) return { answer: "I do not have enough indexed evidence to answer that question.", citations: [] };

  const evidence = rows.map((row, index) => `[${index}] ${row.path}:${row.startLine}-${row.endLine}\n${row.content}`).join("\n\n");
  const answer = client ? (await client.responses.create({ model: config.OPENAI_GENERATION_MODEL, input: [{ role: "system", content: "Answer only from the supplied repository evidence. If insufficient, say so. Include compact [n] citations." }, { role: "user", content: `Question: ${question}\n\nEvidence:\n${evidence}` }] })).output_text : `Indexed evidence found for: ${question}`;
  return { answer, citations: rows.map((row) => ({ path: row.path, startLine: row.startLine, endLine: row.endLine, chunkId: row.id })) };
}
