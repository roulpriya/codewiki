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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function relativeDate(value: string) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  if (days < 30) return `Updated ${days} days ago`;
  return `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(new Date(value))}`;
}

export default function DiscoverRepositories() {
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<"all" | "public" | "private">("all");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<string | null>(null);

  async function load() {
    try {
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

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (discovery?.repositories ?? []).filter((repository) => {
      if (visibility === "private" && !repository.private) return false;
      if (visibility === "public" && repository.private) return false;
      return !term || repository.fullName.toLowerCase().includes(term) || repository.description?.toLowerCase().includes(term);
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
      setDiscovery((current) => current ? { ...current, repositories: current.repositories.map((record) => record.id === repository.id ? { ...record, importedRepositoryId: imported.id, importStatus: "queued" } : record) } : current);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Import could not be started.");
    } finally {
      setImporting(null);
    }
  }

  return <main className="discover-page">
    <header className="discover-topbar"><Link className="brand dark-brand" href="/"><span className="brand-mark">cw</span><span>codewiki</span></Link><Link className="back-link" href="/">← Back to wiki</Link></header>
    <section className="discover-hero">
      <div><p className="eyebrow">REPOSITORY DISCOVERY</p><h1>Choose what Codewiki should understand.</h1><p>Browse repositories available to your configured GitHub account. Importing creates a local, searchable wiki and keeps it synced.</p></div>
      {discovery?.viewer && <a className="viewer-card" href={discovery.viewer.htmlUrl} target="_blank" rel="noreferrer"><Image src={discovery.viewer.avatarUrl} width={44} height={44} unoptimized alt="" /><span><small>CONNECTED AS</small><strong>{discovery.viewer.name ?? discovery.viewer.login}</strong><b>@{discovery.viewer.login}</b></span></a>}
    </section>

    <section className="repository-browser">
      <div className="browser-toolbar"><label className="repository-search"><span>⌕</span><input aria-label="Search repositories" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or description" /></label><div className="visibility-filter" aria-label="Filter by visibility">{(["all", "public", "private"] as const).map((item) => <button className={visibility === item ? "active" : ""} key={item} type="button" onClick={() => setVisibility(item)}>{item}</button>)}</div></div>
      <div className="repository-count"><strong>{filtered.length} repositories</strong><span>Only repositories visible to the configured token are shown.</span></div>
      {error && <div className="error-banner discover-error">{error}<button type="button" onClick={() => void load()}>Try again</button></div>}
      {!discovery && !error ? <div className="repository-loading">Loading repositories from GitHub…</div> : <div className="repository-grid">{filtered.map((repository) => <article className="repository-card" key={repository.id}>
        <div className="repository-card-top"><span className="repo-icon">{repository.private ? "◆" : "◇"}</span><div><h2>{repository.name}</h2><p>{repository.owner}</p></div><span className={repository.private ? "visibility private" : "visibility"}>{repository.private ? "Private" : "Public"}</span></div>
        <p className="repository-description">{repository.description || "No repository description provided."}</p>
        <div className="repository-facts"><span>{repository.language || "Code"}</span>{repository.fork && <span>Fork</span>}{repository.archived && <span>Archived</span>}<span>★ {repository.stars}</span><span>{relativeDate(repository.updatedAt)}</span></div>
        <div className="repository-card-actions">{repository.importedRepositoryId ? <><span className={`import-state ${repository.importStatus ?? "idle"}`}>{repository.importStatus === "ready" ? "✓ Ready" : repository.importStatus === "failed" ? "Import failed" : "Indexing…"}</span><a href={`/?repository=${repository.importedRepositoryId}`}>Open wiki →</a></> : <><a href={repository.htmlUrl} target="_blank" rel="noreferrer">View on GitHub</a><button type="button" disabled={importing === repository.fullName || repository.archived} onClick={() => void importRepository(repository)}>{importing === repository.fullName ? "Starting…" : repository.archived ? "Archived" : "Import repository"}</button></>}</div>
      </article>)}</div>}
      {discovery && filtered.length === 0 && <div className="repository-empty"><strong>No matching repositories</strong><p>Try a different search or visibility filter.</p></div>}
    </section>
  </main>;
}
