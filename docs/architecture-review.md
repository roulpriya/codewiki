# Architecture review — September 2026

## Decision

Keep Bun, TypeScript and React for the current personal, single-process application. There is no Next.js dependency in the manifest: the `src/app` names are historical, and Bun builds and serves a React SPA. A framework migration would not address the measured code-level bottlenecks. Use a maintained Markdown renderer (react-markdown + remark-gfm) instead of hand-written parsing.

This change hardens the local application; it does not establish production readiness for a public, multi-user service. No load benchmark or retrieval quality benchmark has been run. Existing user edits to GitHub checkout/sync and configuration are preserved.

## Implemented

- GFM tables, inline code, emphasis, lists and links render in wiki pages and answers. Raw HTML is disabled, unsafe URL protocols are filtered, and remote images do not load.
- Wiki citation numbers are stored explicitly; source links use the revision commit. Answer source links retain their retrieval commit. Generated overview citation indexes are checked before publishing.
- Chunking overlaps eight lines, limits normal chunks to 80 lines and 6,000 characters, and splits oversized individual lines. These are character bounds, not tokenizer-derived limits or AST parsing.
- Index profile includes the chunking version. Same-profile content hashes reuse embeddings from the preceding snapshot; duplicate new content is embedded once. IDs are deterministic for the same snapshot and chunk.
- Retrieval fuses BM25-style lexical and semantic rankings with reciprocal rank fusion. Paths and camelCase components participate in lexical retrieval. Incompatible vector dimensions are rejected; stale profiles and unavailable inference use lexical retrieval.
- Overview context is selected across files, prioritizes README/manifests/entry points and has a 48,000-character evidence budget instead of taking the first 80 chunks blindly.
- Imports execute serially across repositories and deduplicate by repository to prevent concurrent checkout mutation and unbounded inference/authoring pressure. Scheduler errors are handled. Embedding requests time out and workers can restart.

## Storage and scale boundary

Current state mutation rewrites `state.json`; search reads and parses an entire snapshot JSON and scores all chunks. Both are O(repository/index size), and the process-local mutation chain is not a distributed lock. Serial imports bound active work but increase waiting time; the pending queue is still in memory. Do not run multiple writers against one data directory.

The next local-storage migration should use Bun's built-in SQLite with WAL, transactions, schema versions, relational metadata and FTS5. Store vectors separately from text so lexical reads do not deserialize vectors. Import legacy JSON into a new database transactionally, verify counts and references, keep originals for rollback, and switch only after successful verification. Immutable index-generation IDs are needed to preserve historical citations across chunker/model changes: today indexes are keyed only by commit SHA and an index rebuild can invalidate older revision references.

For an explicitly multi-user deployment, choose PostgreSQL with full-text search and pgvector, object storage for snapshots, and independently deployable workers. Start with a database-backed leased job table, bounded retries, heartbeats and idempotent publication; Redis is not inherently required. Publish a new snapshot/index/wiki pointer in one transaction after all artifacts pass validation. Enforce repository authorization at retrieval and source-read time, tenant-scoped keys, authentication, rate limits, request/body budgets, audit logs, retention and tested backup restoration before exposure.

## Embedding decision

Keep the existing local Jina code model until an evaluation supports a replacement. Its model card documents code retrieval and long context; that does not establish that it is optimal for these repositories. Local inference avoids sending code to a separate embedding API, but model cold starts and CPU/RAM costs remain operational concerns. Pin a model revision and include revision, dimensions, pooling, normalization, dtype and tokenizer/chunker version in the index generation before reproducible shared deployments.

A useful comparison includes lexical-only, the existing Jina model and a candidate code embedding model on a versioned set of real repository questions. Measure Recall@8, MRR, citation correctness, unsupported-answer rate, cold/warm latency, peak RSS, initial indexing time and incremental update cost. Add AST-aware chunks only if they improve those results enough to justify parser maintenance. An ANN index is justified by measured retrieval latency and corpus size, not by the presence of embeddings alone.

## Remaining production work

- Durable bounded admission, cancellation and job leases; current retry recovery applies to local imports.
- Tokenizer-aware generation budgets, generation timeouts across providers, and strict validation of answer citations as well as overview citations.
- Tests for interrupted publication, disk-full writes, schema migration, worker death and concurrent import submission.
- Retrieval fixtures with relevance judgments and representative large-repository load tests.
- Service metrics: queue depth/age, sync duration, embedding cache hit rate, model errors, retrieval latency and generation errors.
- Content parsing should eventually derive the table of contents from the same Markdown AST; the current section splitter is still separate.

## References

- Bun SQLite: https://bun.sh/docs/runtime/sqlite
- React Markdown security and behavior: https://github.com/remarkjs/react-markdown
- GFM support: https://github.com/remarkjs/remark-gfm
- Current model: https://huggingface.co/jinaai/jina-embeddings-v2-base-code
