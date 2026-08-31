"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";

type Viewer = { login: string; name: string | null; avatarUrl: string; htmlUrl: string };
type Repository = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  htmlUrl: string;
  language: string | null;
  stars: number;
  updatedAt: string;
  defaultBranch: string;
  importedRepositoryId: string | null;
  importStatus: "idle" | "queued" | "checking" | "running" | "ready" | "failed" | null;
};
type Discovery = { viewer: Viewer; repositories: Repository[] };
type AuthStatus = { authenticated: boolean; source: "environment" | "gh" | null; message: string };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function relativeDate(value: string) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (days === 0) return "updated today";
  if (days === 1) return "updated yesterday";
  if (days < 30) return `updated ${days} days ago`;
  return `updated ${new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(new Date(value))}`;
}

function importCopy(status: Repository["importStatus"]) {
  if (status === "ready") return "indexed";
  if (status === "failed") return "import failed";
  return "indexing…";
}

export default function DiscoverRepositories() {
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<"all" | "public" | "private">("all");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function load() {
    try {
      const status = await requestJson<AuthStatus>("/github/auth");
      setAuth(status);
      if (status.authenticated) setConnecting(false);
      if (!status.authenticated) {
        setDiscovery(null);
        return;
      }
      setDiscovery(await requestJson<Discovery>("/github/repositories"));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Repositories could not be loaded.");
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!connecting) return;
    const interval = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(interval);
  }, [connecting]);

  async function connectGitHub() {
    setConnecting(true);
    setError("");
    try {
      const result = await requestJson<{ message: string }>("/github/auth/login", { method: "POST" });
      setError(result.message);
    } catch (connectError) {
      setConnecting(false);
      setError(connectError instanceof Error ? connectError.message : "GitHub sign-in could not be started.");
    }
  }

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (discovery?.repositories ?? []).filter((repository) => {
      if (visibility === "private" && !repository.private) return false;
      if (visibility === "public" && repository.private) return false;
      return (
        !term ||
        repository.fullName.toLowerCase().includes(term) ||
        (repository.description ?? "").toLowerCase().includes(term)
      );
    });
  }, [discovery?.repositories, query, visibility]);

  async function importRepository(repository: Repository) {
    setImporting(repository.fullName);
    setError("");
    try {
      const imported = await requestJson<{ id: string }>("/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: repository.owner, name: repository.name }),
      });
      setDiscovery((current) =>
        current
          ? {
              ...current,
              repositories: current.repositories.map((record) =>
                record.id === repository.id
                  ? { ...record, importedRepositoryId: imported.id, importStatus: "queued" }
                  : record,
              ),
            }
          : current,
      );
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Import could not be started.");
    } finally {
      setImporting(null);
    }
  }

  return (
    <>
      <header className="topbar">
        <Link className="topbar-brand" href="/">
          Codewiki
        </Link>
        <span className="crumb">
          <span className="crumb-sep">/</span>
          <span className="crumb-repo">discover</span>
        </span>
        <div className="topbar-search">
          <label className="sr-only" htmlFor="discover-search">
            Search repositories
          </label>
          <input
            className="input"
            id="discover-search"
            type="text"
            placeholder="Search by name or description"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="topbar-actions">
          <Link className="btn btn-quiet btn-sm" href="/settings">AI settings</Link>
          <Link className="btn btn-outline btn-sm" href="/">
            Back to wiki
          </Link>
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          {error}
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      <main className="page">
        <h1 className="page-title">Choose what Codewiki should understand</h1>
        <p className="page-lede">
          Every repository your GitHub connection can read. Adding one builds a local, source-cited wiki and keeps
          it synced with the default branch.
        </p>

        {auth && !auth.authenticated && (
          <section className="empty" aria-live="polite">
            <h2>Connect GitHub to browse your repositories</h2>
            <p className="empty-note">{auth.message}</p>
            <button className="btn btn-accent" type="button" disabled={connecting} onClick={() => void connectGitHub()}>
              {connecting ? "Waiting for GitHub…" : "Sign in with GitHub"}
            </button>
            <p className="empty-note">This opens GitHub’s sign-in page through GitHub CLI. You can also run <code>gh auth login</code> in the terminal.</p>
          </section>
        )}

        {discovery?.viewer && (
          <a className="viewer" href={discovery.viewer.htmlUrl} target="_blank" rel="noreferrer">
            <Image src={discovery.viewer.avatarUrl} width={36} height={36} unoptimized alt="" />
            <span className="viewer-text">
              <span className="viewer-label">Connected as</span>
              <span className="viewer-name">
                {discovery.viewer.name ?? discovery.viewer.login}{" "}
                <b className="viewer-login">@{discovery.viewer.login}</b>
              </span>
            </span>
          </a>
        )}

        {auth?.authenticated && <div className="repos-toolbar">
          <span className="page-lede" style={{ margin: 0, flex: 1 }}>
            {discovery ? `${filtered.length} repositories` : "Loading repositories from GitHub…"}
          </span>
          <div className="seg" aria-label="Filter by visibility">
            {(["all", "public", "private"] as const).map((item) => (
              <button
                className={visibility === item ? "is-active" : ""}
                key={item}
                type="button"
                onClick={() => setVisibility(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>}

        {auth?.authenticated && <div className="rows">
          {filtered.map((repository) => (
            <div className="repo-row" key={repository.id}>
              <span className="repo-row-main">
                <span className="repo-row-name">{repository.fullName}</span>
                <span className="repo-row-desc">{repository.description || "No description provided."}</span>
                <span className="facts">
                  <span>{repository.private ? "Private" : "Public"}</span>
                  {repository.language && <span>{repository.language}</span>}
                  {repository.fork && <span>Fork</span>}
                  {repository.archived && <span>Archived</span>}
                  <span>★ {repository.stars}</span>
                  <span>{relativeDate(repository.updatedAt)}</span>
                </span>
              </span>

              {repository.importedRepositoryId ? (
                <>
                  <span
                    className={`repo-row-meta ${repository.importStatus === "failed" ? "is-failed" : repository.importStatus === "ready" ? "" : "is-busy"}`}
                  >
                    {importCopy(repository.importStatus)}
                  </span>
                  <Link className="btn btn-outline btn-sm" href={`/?repository=${repository.importedRepositoryId}`}>
                    Open
                  </Link>
                </>
              ) : (
                <>
                  <a className="repo-row-meta is-dim" href={repository.htmlUrl} target="_blank" rel="noreferrer">
                    GitHub ↗
                  </a>
                  <button
                    className="btn btn-accent btn-sm"
                    type="button"
                    disabled={importing === repository.fullName || repository.archived}
                    onClick={() => void importRepository(repository)}
                  >
                    {importing === repository.fullName ? "Adding…" : repository.archived ? "Archived" : "Add"}
                  </button>
                </>
              )}
            </div>
          ))}

          {discovery && filtered.length === 0 && (
            <p className="empty-note">No repository matches that search or filter.</p>
          )}
        </div>}
      </main>
    </>
  );
}
