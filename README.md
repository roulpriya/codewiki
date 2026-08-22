# Codewiki

Codewiki is a personal, source-cited wiki for GitHub repositories. It runs as
one local application or Docker image. GitHub access uses your personal access
token, and every repository snapshot, search index, wiki revision, and sync run
is stored as an ordinary file beneath one data directory.

## Run it

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

## Repository sync

Codewiki checks repositories when the app starts if their last check is due,
then checks them periodically while it is running. The default interval is 24
hours and can be changed with `SYNC_INTERVAL_HOURS`. A check fetches only the
default branch head first. When its commit SHA is unchanged, the existing index
and wiki are retained without downloading files or calling the OpenAI API.
When the SHA changes—from a merged pull request or a direct commit—Codewiki
creates a new snapshot, index, and cited wiki revision. Use **Check now** in the
interface to run the same check manually.
