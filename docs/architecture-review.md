# Architecture review — September 2026

## Decision

Keep Bun, TypeScript and React for the current personal, single-process application. There is no Next.js dependency in the manifest: the `src/app` names are historical, and Bun builds and serves a React SPA. A framework migration would not address the measured code-level bottlenecks. Use a maintained Markdown renderer (react-markdown + remark-gfm) instead of hand-written parsing.

This change hardens the local application; it does not establish production readiness for a public, multi-user service. No load benchmark or retrieval quality benchmark has been run. Existing user edits to GitHub checkout/sync and configuration are preserved.

## Implemented

- GFM tables, inline code, emphasis, lists and links render in wiki pages and answers. Raw HTML is disabled, unsafe URL protocols are filtered, and remote images do not load.
- Wiki citation numbers are stored explicitly; source links use the revision commit. Answer source links retain their retrieval commit. Generated overview citation indexes are checked before publishing.
- Chunking overlaps eight lines, limits normal chunks to 80 lines and 6,000 characters, and splits oversized individual lines. These are character bounds, not tokenizer-derived limits or AST parsing.
- Index profile includes the chunking version. IDs are deterministic for the same snapshot and chunk.
- Retrieval uses BM25-style lexical ranking. Paths and camelCase components participate in retrieval.
- Overview context is selected across files, prioritizes README/manifests/entry points and has a 48,000-character evidence budget instead of taking the first 80 chunks blindly.
- Imports execute serially across repositories and deduplicate by repository to prevent concurrent checkout mutation and unbounded authoring pressure. Scheduler errors are handled.

## Storage and scale boundary

Current state mutation rewrites `state.json`; search reads and parses an entire snapshot JSON and scores all chunks. Both are O(repository/index size), and the process-local mutation chain is not a distributed lock. Serial imports bound active work but increase waiting time; the pending queue is still in memory. Do not run multiple writers against one data directory.

The next local-storage migration should use Bun's built-in SQLite with WAL, transactions, schema versions, relational metadata and FTS5. Import legacy JSON into a new database transactionally, verify counts and references, keep originals for rollback, and switch only after successful verification. Immutable index-generation IDs are needed to preserve historical citations across chunker changes: today indexes are keyed only by commit SHA and an index rebuild can invalidate older revision references.

For an explicitly multi-user deployment, choose PostgreSQL with full-text search, object storage for snapshots, and independently deployable workers. Start with a database-backed leased job table, bounded retries, heartbeats and idempotent publication; Redis is not inherently required. Publish a new snapshot/index/wiki pointer in one transaction after all artifacts pass validation. Enforce repository authorization at retrieval and source-read time, tenant-scoped keys, authentication, rate limits, request/body budgets, audit logs, retention and tested backup restoration before exposure.

## Remaining production work

- Durable bounded admission, cancellation and job leases; current retry recovery applies to local imports.
- Tokenizer-aware generation budgets, generation timeouts across providers, and strict validation of answer citations as well as overview citations.
- Tests for interrupted publication, disk-full writes, schema migration, worker death and concurrent import submission.
- Retrieval fixtures with relevance judgments and representative large-repository load tests.
- Service metrics: queue depth/age, sync duration, retrieval latency and generation errors.
- Content parsing should eventually derive the table of contents from the same Markdown AST; the current section splitter is still separate.

## References

- Bun SQLite: https://bun.sh/docs/runtime/sqlite
- React Markdown security and behavior: https://github.com/remarkjs/react-markdown
- GFM support: https://github.com/remarkjs/remark-gfm
