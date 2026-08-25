# Codewiki

Codewiki is a personal, source-cited wiki for GitHub repositories. It runs as
one local application or Docker image. GitHub access uses your personal access
token, and every repository snapshot, search index, wiki revision, and sync run
is stored as an ordinary file beneath one data directory.

## Run it

Codewiki requires [Bun](https://bun.sh) 1.3.12 or newer for local development.

Create a fine-grained GitHub personal access token with **Metadata: read** and
**Contents: read** for the repositories you want to import. If an organization
requires SSO, authorize the token for that organization.

Copy `.env.example` to `.env`, add the token (and optionally an OpenAI API key),
then start Codewiki:

```sh
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The interface asks only
for an owner and repository name; it uses the container's `GITHUB_TOKEN` and
never stores that token in its data files.

Use **Discover repositories** to browse repositories visible to the configured
GitHub token, including repositories owned by the account, collaborator access,
and organization repositories. Search or filter the list, then start an import
without typing an owner and repository name. GitHub token repository selection
and organization SSO rules still determine which repositories appear.

## Portable image

To use an already-built image instead of Compose:

```sh
docker run -d --name codewiki \
  -p 3000:3000 \
  -v codewiki-data:/data \
  --env-file .env \
  codewiki:local
```

The `/data` volume contains the complete local knowledge base:

```text
/data/state.json             repository, wiki, revision, and run metadata
/data/indexes/               searchable code chunks and optional embeddings
/data/objects/               raw snapshots and generated Markdown revisions
```

State and index files are replaced atomically, so restarting does not require a
database recovery step. Back up `/data` to preserve the knowledge base.
PostgreSQL, Redis, pgvector, S3, MinIO, GitHub Apps, OAuth, teams, and
multi-user workflows are intentionally outside this local version.

## Claude Agent SDK

Codewiki includes a read-only Claude Agent SDK entrypoint for asking questions
about this workspace. Set `ANTHROPIC_API_KEY` in `.env` (or sign in with Claude
Code), then run:

```sh
bun run claude -- "Explain the repository architecture."
```

The agent is limited to `Read`, `Glob`, and `Grep`, executes with Bun, and has
its working directory set to this repository.

## Repository sync

Codewiki checks repositories when the app starts if their last check is due,
then checks them periodically while it is running. The default interval is 24
hours and can be changed with `SYNC_INTERVAL_HOURS`. A check fetches only the
default branch head first. When its commit SHA is unchanged, the existing index
and wiki are retained without downloading files or calling the OpenAI API.
When the SHA changes—from a merged pull request or a direct commit—Codewiki
creates a new snapshot, index, and cited wiki revision. Use **Check now** in the
interface to run the same check manually.

## Local MCP server

Codewiki includes a local `stdio` MCP server that exposes repository discovery,
status, overview, grounded Q&A, import, and update-check tools. Keep the
Codewiki application running, then start the MCP server with:

```sh
CODEWIKI_API_ORIGIN=http://127.0.0.1:3000/api bun run mcp
```

The available tools are `list_repositories`, `discover_repositories`,
`get_repository_status`, `get_repository_overview`, `ask_question`,
`import_repository`, and `check_repository`. Read-only tools are annotated
separately from operations that import or synchronize local data.

To register the local server with Codex, use the absolute project path and the
port where Codewiki is running:

```sh
codex mcp add codewiki \
  --env CODEWIKI_API_ORIGIN=http://127.0.0.1:3000/api \
  -- bun --cwd /absolute/path/to/code-wiki run mcp
```

Register it with Claude Code at user scope so it is available across projects:

```sh
claude mcp add --scope user codewiki \
  -e CODEWIKI_API_ORIGIN=http://127.0.0.1:3000/api \
  -- bun --cwd /absolute/path/to/code-wiki run mcp
```

Keep the Codewiki application running while either client uses the MCP server.
After registration, restart each client so it reloads its MCP configuration:

- **Codex desktop:** press `Command-Q`, reopen Codex, and start a new task. Open
  MCP settings or enter `/mcp` to confirm that `codewiki` is enabled.
- **Claude Code:** enter `/exit` or press `Control-C`, run `claude` again, and
  enter `/mcp` to confirm that `codewiki` is connected.

You can also verify the saved configuration from a terminal:

```sh
codex mcp get codewiki
claude mcp get codewiki
```

If the application uses a different port, change `CODEWIKI_API_ORIGIN`. For
example, the current local test instance on port `3100` uses
`http://127.0.0.1:3100/api`.
