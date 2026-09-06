import type { IndexChunk } from "./state.js";

export const CHUNK_PROFILE = "lines-v2:80:8:6000";

export function splitFile(path: string, content: string) {
  const lines = content.split("\n");
  const chunks: Array<{ path: string; startLine: number; endLine: number; content: string }> = [];
  for (let start = 0; start < lines.length;) {
    let end = start;
    let size = 0;
    while (end < lines.length && end - start < 80 && (end === start || size + lines[end].length + 1 <= 6000)) {
      size += lines[end].length + 1;
      end++;
    }
    // Split pathological generated lines too; preserve their source line coordinates.
    const body = lines.slice(start, end).join("\n");
    for (let offset = 0; offset < body.length; offset += 6000) {
      const part = body.slice(offset, offset + 6000);
      if (part.trim()) chunks.push({ path, startLine: start + 1, endLine: end, content: part });
    }
    start = end === lines.length ? end : Math.max(start + 1, end - 8);
  }
  return chunks;
}

const tokens = (text: string): string[] => text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];

export function retrieve(chunks: IndexChunk[], question: string, limit = 8) {
  const terms = [...new Set(tokens(question))];
  const documents = chunks.map((chunk) => tokens(`${chunk.path} ${chunk.path} ${chunk.content}`));
  const frequencies = terms.map((term) => documents.reduce((n, doc) => n + Number(doc.includes(term)), 0));
  const average = documents.reduce((n, doc) => n + doc.length, 0) / (documents.length || 1);
  const lexical = documents.map((doc, index) => ({ index, score: terms.reduce((score, term, t) => {
    const tf = doc.filter((token) => token === term).length;
    const idf = Math.log(1 + (chunks.length - frequencies[t] + 0.5) / (frequencies[t] + 0.5));
    return score + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / (average || 1)));
  }, 0) }));
  return lexical.filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ index }) => chunks[index]);
}

export function overviewEvidence(chunks: IndexChunk[], budget = 48000) {
  const byPath = new Map<string, IndexChunk[]>();
  for (const chunk of chunks) byPath.set(chunk.path, [...(byPath.get(chunk.path) ?? []), chunk]);
  const priority = (path: string) => /(^|\/)(readme[^/]*|package.json|pyproject.toml|cargo.toml|go.mod)$/i.test(path) ? 0 : /(^|\/)(index|main|server|app|web|routes|config)[./]/i.test(path) ? 1 : 2;
  const groups = [...byPath].sort((a, b) => priority(a[0]) - priority(b[0]) || a[0].localeCompare(b[0])).map(([, group]) => group);
  const selected: IndexChunk[] = [];
  let used = 0;
  for (let depth = 0; selected.length < 80 && groups.some((group) => depth < group.length); depth++) {
    for (const group of groups) {
      const chunk = group[depth];
      if (!chunk || selected.length >= 80) continue;
      const cost = chunk.content.length + chunk.path.length + 80;
      if (used + cost > budget) continue;
      selected.push(chunk); used += cost;
    }
  }
  return selected;
}
