# Codewiki

Codewiki is a personal, source-cited wiki for GitHub repositories. It runs as
one local application or Docker image. GitHub access uses your personal access
token, and every repository snapshot, search index, wiki revision, and sync run
is stored as an ordinary file beneath one data directory.

The local embedding model is cached separately at `.cache/huggingface` by
default. It can be safely deleted and is never part of the application data or
repository history.

## Run it

Codewiki requires [Bun](https://bun.sh) 1.3.12 or newer for local development.

### npm CLI

Install the CLI globally (or replace `codewiki` with `npx @roulpriya/codewiki`)
and start the application:

```sh
npm install -g @roulpriya/codewiki
codewiki start
```

Open [http://localhost:3000](http://localhost:3000). The CLI creates and uses
`./data` in the directory where you run it by default. Set `DATA_DIR` to use a
specific location. `codewiki start` runs in the background; use `codewiki
status`, `codewiki logs`, `codewiki stop`, and `codewiki restart` to manage it.
`codewiki mcp` starts the daemon when needed and exposes the stdio MCP server
for an MCP client. Bun 1.3.12 or newer remains required because Codewiki runs
its local services with Bun.

Codewiki automatically uses an existing [GitHub CLI](https://cli.github.com/)
session when available. Run `gh auth login` once, then open **Discover
repositories** and choose **Sign in with GitHub** if needed; the app launches
the GitHub CLI browser flow and refreshes when it completes. For Docker or
headless deployments, set `GITHUB_TOKEN` instead. Create a fine-grained token
with **Metadata: read** and **Contents: read** for the repositories you want to
import. If an organization requires SSO, authorize the token for that
organization.

Copy `.env.example` to `.env` if you are using a token, then start Codewiki:

```sh
docker compose up --build
```

## AI provider

Open **AI settings** in Codewiki to connect a provider for generated wiki pages
and grounded answers. Codewiki prefers a signed-in Codex CLI (your eligible
ChatGPT plan), then Claude Code (an eligible Claude subscription), and finally
an OpenAI API key. The settings page can start either CLI's browser sign-in
flow. This works only when the app runs on the same machine as the CLI session.

ChatGPT and the OpenAI API have separate billing, so a ChatGPT subscription
cannot be used directly by the OpenAI SDK. If neither subscription provider is
available, save an OpenAI API key in AI settings or set `OPENAI_API_KEY` in
`.env`. A key saved in the app is kept under the local data directory with
owner-only file permissions; `OPENAI_API_KEY` takes precedence. Docker and
headless deployments should use environment keys.

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

## Code embeddings

Codewiki runs Jina's `jinaai/jina-embeddings-v2-base-code` locally through
Hugging Face Transformers.js and Bun—no embedding API key or Python runtime is
required. The first run downloads the quantized ONNX model into the configured
local cache. Existing repositories are automatically re-indexed after an
embedding model change. OpenAI remains optional and is used only for authored
wiki pages and grounded answer prose.

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
status, overview, grounded Q&A, import, and update-check tools. The CLI starts
the Codewiki daemon automatically if it is not already running, then starts
the MCP server with:

```sh
codewiki mcp
```

The available tools are `list_repositories`, `discover_repositories`,
`get_repository_status`, `get_repository_overview`, `ask_question`,
`import_repository`, and `check_repository`. Read-only tools are annotated
separately from operations that import or synchronize local data.

To register the installed local server with Codex:

```sh
codex mcp add codewiki \
  -- codewiki mcp
```

Register it with Claude Code at user scope so it is available across projects:

```sh
claude mcp add --scope user codewiki \
  -- codewiki mcp
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

For source checkout development rather than a global installation, replace
`codewiki mcp` with `bun run mcp` and keep the application running separately.
