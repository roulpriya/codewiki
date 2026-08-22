"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type Repository = {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  indexed_sha: string | null;
  status: "idle" | "queued" | "checking" | "running" | "ready" | "failed";
  created_at: string;
  last_checked_at?: string | null;
  last_synced_at?: string | null;
};

type PageSummary = { id: string; slug: string; title: string; summary: string | null; created_at: string | null };
type PageDetail = PageSummary & { markdown: string; citations: Array<{ path: string; start_line: number; end_line: number }> };
type SyncRun = { id: string; kind: string; status: "running" | "completed" | "failed"; detail: { changed?: boolean; previousSha?: string | null; chunkCount?: number; sha?: string; message?: string }; created_at: string; finished_at: string | null };
type Answer = { answer: string; citations: string[] };
type WikiSection = { id: string; title: string; markdown: string; preview: string };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function statusCopy(status: Repository["status"]) {
  if (status === "queued") return "Waiting to start";
  if (status === "checking") return "Checking for updates";
  if (status === "running") return "Indexing repository";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Import failed";
  return "Not indexed";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\|.*\|$/gm, "")
    .replace(/^[-*#>]\s*/gm, "")
    .replace(/\[(.*?)\]\([^)]*\)/g, "$1")
    .replace(/\[\d+\]/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseWiki(markdown: string): { introduction: string; sections: WikiSection[] } {
  const lines = markdown.split("\n");
  const sections: WikiSection[] = [];
  const introduction: string[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (/^#\s+/.test(line)) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (current) {
        const markdownBody = current.lines.join("\n").trim();
        const preview = plainText(markdownBody);
        sections.push({ id: `section-${sections.length}`, title: current.title, markdown: markdownBody, preview: preview.length > 150 ? `${preview.slice(0, 147)}…` : preview });
      }
      current = { title: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      introduction.push(line);
    }
  }

  if (current) {
    const markdownBody = current.lines.join("\n").trim();
    const preview = plainText(markdownBody);
    sections.push({ id: `section-${sections.length}`, title: current.title, markdown: markdownBody, preview: preview.length > 150 ? `${preview.slice(0, 147)}…` : preview });
  }

  return { introduction: introduction.join("\n").trim(), sections };
}

function MarkdownContent({ markdown }: { markdown: string }) {
  const blocks = markdown.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return <div className="markdown-content">{blocks.map((block, blockIndex) => {
    if (block.startsWith("```")) {
      return <pre key={blockIndex}><code>{block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code></pre>;
    }
    return block.split(/\n{2,}/).filter(Boolean).map((part, partIndex) => {
      const key = `${blockIndex}-${partIndex}`;
      const heading = part.match(/^(#{1,4})\s+([\s\S]+)$/);
      if (heading) {
        const level = heading[1].length;
        if (level === 1) return <h1 key={key}>{heading[2]}</h1>;
        if (level === 2) return <h2 key={key}>{heading[2]}</h2>;
        return <h3 key={key}>{heading[2]}</h3>;
      }
      const lines = part.split("\n");
      if (lines.every((line) => /^[-*]\s+/.test(line))) return <ul key={key}>{lines.map((line) => <li key={line}>{line.replace(/^[-*]\s+/, "")}</li>)}</ul>;
      if (lines.every((line) => /^\d+\.\s+/.test(line))) return <ol key={key}>{lines.map((line) => <li key={line}>{line.replace(/^\d+\.\s+/, "")}</li>)}</ol>;
      if (lines.every((line) => line.trim().startsWith("|"))) return <pre className="markdown-table" key={key}>{part}</pre>;
      return <p key={key}>{part}</p>;
    });
  })}</div>;
}

export default function Home() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [activeRepositoryId, setActiveRepositoryId] = useState<string | null>(null);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [page, setPage] = useState<PageDetail | null>(null);
  const [activeSectionId, setActiveSectionId] = useState("overview");
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [isAnswering, setIsAnswering] = useState(false);
  const [showImporter, setShowImporter] = useState(false);
  const [owner, setOwner] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [isSubmittingImport, setIsSubmittingImport] = useState(false);
  const [loadError, setLoadError] = useState("");
  const questionInput = useRef<HTMLInputElement>(null);

  const activeRepository = useMemo(() => repositories.find((repository) => repository.id === activeRepositoryId) ?? null, [repositories, activeRepositoryId]);
  const latestRun = runs[0] ?? null;
  const wiki = useMemo(() => parseWiki(page?.markdown ?? ""), [page?.markdown]);
  const activeSection = wiki.sections.find((section) => section.id === activeSectionId) ?? null;

  const refreshRepositories = useCallback(async () => {
    try {
      const records = await requestJson<Repository[]>("/repositories");
      setRepositories(records);
      setActiveRepositoryId((current) => {
        const requested = new URLSearchParams(window.location.search).get("repository");
        if (requested && records.some((record) => record.id === requested)) return requested;
        return current && records.some((record) => record.id === current) ? current : records[0]?.id ?? null;
      });
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load repositories.");
    }
  }, []);

  const refreshActiveRepository = useCallback(async (id: string) => {
    const [repository, runRecords] = await Promise.all([
      requestJson<Repository>(`/repositories/${id}`),
      requestJson<SyncRun[]>(`/repositories/${id}/runs`),
    ]);
    setRepositories((current) => current.map((item) => item.id === repository.id ? repository : item));
    setRuns(runRecords);
    if (repository.indexed_sha) {
      const pageRecords = await requestJson<PageSummary[]>(`/repositories/${id}/pages`);
      setPages(pageRecords);
      setActiveSlug((current) => current && pageRecords.some((item) => item.slug === current) ? current : pageRecords[0]?.slug ?? null);
    } else {
      setPages([]);
      setActiveSlug(null);
      setPage(null);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refreshRepositories(), 0);
    return () => window.clearTimeout(timeout);
  }, [refreshRepositories]);

  useEffect(() => {
    if (!activeRepositoryId) return;
    const timeout = window.setTimeout(() => void refreshActiveRepository(activeRepositoryId).catch((error) => setLoadError(error instanceof Error ? error.message : "Could not load repository.")), 0);
    const interval = window.setInterval(() => void refreshActiveRepository(activeRepositoryId).catch(() => undefined), 1800);
    return () => { window.clearTimeout(timeout); window.clearInterval(interval); };
  }, [activeRepositoryId, refreshActiveRepository]);

  useEffect(() => {
    if (!activeRepositoryId || !activeSlug) return;
    const timeout = window.setTimeout(() => void requestJson<PageDetail>(`/repositories/${activeRepositoryId}/pages/${activeSlug}`).then((record) => { setPage(record); setActiveSectionId("overview"); }).catch((error) => setLoadError(error instanceof Error ? error.message : "Could not load wiki page.")), 0);
    return () => window.clearTimeout(timeout);
  }, [activeRepositoryId, activeSlug]);

  async function startImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmittingImport(true);
    setImportMessage("");
    try {
      const imported = await requestJson<Repository>("/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner, name: repositoryName }) });
      setRepositories((current) => [imported, ...current.filter((item) => item.id !== imported.id)]);
      setActiveRepositoryId(imported.id);
      setImportMessage("Import started. Progress is shown in the right panel.");
      await refreshActiveRepository(imported.id);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "Repository import could not be started.");
    } finally {
      setIsSubmittingImport(false);
    }
  }

  async function reindex() {
    if (!activeRepository) return;
    await requestJson(`/repositories/${activeRepository.id}/import`, { method: "POST" });
    await refreshActiveRepository(activeRepository.id);
  }

  async function askQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeRepository?.indexed_sha || !question.trim()) return;
    setIsAnswering(true);
    setAnswer(null);
    try {
      const data = await requestJson<{ answer: string; citations: Array<{ path: string; startLine: number; endLine: number }> }>(`/repositories/${activeRepository.id}/questions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: question.trim() }) });
      setAnswer({ answer: data.answer, citations: data.citations.map((citation) => `${citation.path} · ${citation.startLine}–${citation.endLine}`) });
      setQuestion("");
    } catch (error) {
      setAnswer({ answer: error instanceof Error ? error.message : "Question could not be answered.", citations: [] });
    } finally {
      setIsAnswering(false);
    }
  }

  function prepareQuestion(value: string) {
    setQuestion(value);
    window.setTimeout(() => questionInput.current?.focus(), 0);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top"><span className="brand-mark">cw</span><span>codewiki</span></a>

        {repositories.length > 0 ? <label className="repository-picker">Repository<select aria-label="Active repository" value={activeRepositoryId ?? ""} onChange={(event) => { setActiveRepositoryId(event.target.value); setPage(null); setAnswer(null); }}>
          {repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.owner}/{repository.name}</option>)}
        </select></label> : <div className="empty-repository">No repository imported</div>}

        <div className="sidebar-status">
          <span className={`status-dot ${activeRepository?.status ?? "idle"}`} />
          <div><strong>{activeRepository ? statusCopy(activeRepository.status) : "Local mode"}</strong><small>{activeRepository?.indexed_sha ? `${activeRepository.default_branch} · ${activeRepository.indexed_sha.slice(0, 7)}` : "Filesystem storage"}</small></div>
        </div>

        <button className="import-button" type="button" onClick={() => { setShowImporter(true); setImportMessage(""); }}><span>+</span>Import repository</button>
        <Link className="discover-link" href="/discover"><span>⌕</span>Discover repositories</Link>
      </aside>

      <section className="workspace" id="top">
        <header className="topbar">
          <div><span className="topbar-label">LOCAL WIKI</span><strong>{activeRepository ? `${activeRepository.owner}/${activeRepository.name}` : "Import a repository to begin"}</strong></div>
          {activeRepository && <button className="secondary-button" type="button" disabled={activeRepository.status === "queued" || activeRepository.status === "checking" || activeRepository.status === "running"} onClick={() => void reindex()}>Check now</button>}
        </header>

        {loadError && <div className="error-banner">{loadError}</div>}

        <div className="content-grid">
          <nav className="wiki-tree" aria-label="Wiki pages">
            <p className="eyebrow">UNDERSTAND THIS REPO</p>
            {pages.length ? <>
              {pages.map((item) => <button className={item.slug === activeSlug && activeSectionId === "overview" ? "tree-page selected" : "tree-page"} key={item.id} type="button" onClick={() => { setActiveSlug(item.slug); setActiveSectionId("overview"); }}><span>⌂</span>Overview</button>)}
              {wiki.sections.length > 0 && <div className="section-tree"><p>Explore details</p>{wiki.sections.map((section) => <button className={section.id === activeSectionId ? "tree-page selected" : "tree-page"} key={section.id} type="button" onClick={() => setActiveSectionId(section.id)}><span>›</span>{section.title}</button>)}</div>}
            </> : <p className="tree-empty">{activeRepository?.status === "ready" ? "No pages generated." : "Pages appear after indexing completes."}</p>}
          </nav>

          <article className="document">
            {page ? <>
              <div className="document-meta"><span className="status-pill">Generated</span><span>{formatDate(page.created_at)}</span></div>
              {activeSection ? <>
                <button className="back-to-overview" type="button" onClick={() => setActiveSectionId("overview")}>← Project overview</button>
                <h1>{activeSection.title}</h1>
                <MarkdownContent markdown={activeSection.markdown} />
              </> : <>
                <p className="eyebrow overview-label">PROJECT OVERVIEW</p>
                <h1>{page.title}</h1>
                <p className="lede">{page.summary}</p>
                {wiki.introduction && <MarkdownContent markdown={wiki.introduction} />}
                <section className="topic-section">
                  <div className="section-heading"><div><p className="eyebrow">EXPLORE</p><h2>Understand it one topic at a time</h2></div><span>{wiki.sections.length} topics</span></div>
                  <div className="topic-grid">{wiki.sections.map((section, index) => <button key={section.id} type="button" onClick={() => setActiveSectionId(section.id)}><span className="topic-number">{String(index + 1).padStart(2, "0")}</span><strong>{section.title}</strong><p>{section.preview || "Open this topic for more detail."}</p><b>Read topic →</b></button>)}</div>
                </section>
                <section className="question-starters"><p className="eyebrow">ASK FOR THE DETAILS YOU NEED</p><h2>Good places to start</h2><div>{["How does this project work end to end?", "Where should a new developer start?", "What are the biggest risks or unfinished areas?"].map((prompt) => <button key={prompt} type="button" onClick={() => prepareQuestion(prompt)}>{prompt}<span>↗</span></button>)}</div></section>
              </>}
              <details className="evidence-disclosure"><summary><span>View source evidence</span><small>{page.citations.length} cited chunks</small></summary><div className="source-list">{page.citations.map((citation) => <div className="source-row" key={`${citation.path}-${citation.start_line}`}><span className="file-badge">SRC</span><span><strong>{citation.path}</strong><small>Lines {citation.start_line}–{citation.end_line}</small></span></div>)}</div></details>
            </> : <div className="empty-document">
              <span className="empty-icon">⌘</span>
              <h1>{activeRepository ? statusCopy(activeRepository.status) : "Your local code wiki"}</h1>
              <p>{activeRepository?.status === "queued" ? "The import request is waiting to start." : activeRepository?.status === "checking" ? "Codewiki is comparing the remote default branch with the local snapshot." : activeRepository?.status === "running" ? "Codewiki found a new commit and is updating the local index and wiki." : activeRepository?.status === "failed" ? latestRun?.detail.message ?? "The import failed. Check the progress panel for details." : "Import a GitHub repository to create a searchable, source-cited wiki stored on this machine."}</p>
              {!activeRepository && <button className="primary-action" type="button" onClick={() => setShowImporter(true)}>Import repository</button>}
            </div>}
          </article>

          <aside className="right-rail">
            <p className="eyebrow">IMPORT PROGRESS</p>
            {activeRepository ? <>
              <div className={`progress-summary ${activeRepository.status}`}><span>{activeRepository.status === "checking" || activeRepository.status === "running" ? "↻" : activeRepository.status === "ready" ? "✓" : activeRepository.status === "failed" ? "!" : "·"}</span><div><strong>{statusCopy(activeRepository.status)}</strong><small>{activeRepository.status === "checking" ? "Comparing the remote and local commit SHA." : activeRepository.status === "running" ? "A new commit was found. Updating local files." : activeRepository.status === "ready" ? latestRun?.detail.changed === false ? "Remote is unchanged. Nothing was regenerated." : "Local wiki matches the remote branch." : "Status updates automatically."}</small></div></div>
              {(activeRepository.status === "queued" || activeRepository.status === "checking" || activeRepository.status === "running") && <div className="progress-bar"><i /></div>}
              <ol className="progress-steps">
                <li className={activeRepository.status === "checking" ? "active" : "done"}><span>1</span><div><strong>Check remote branch</strong><small>Compare the latest commit SHA</small></div></li>
                <li className={activeRepository.status === "running" ? "active" : activeRepository.status === "ready" && latestRun?.detail.changed ? "done" : activeRepository.status === "ready" && latestRun?.detail.changed === false ? "skipped" : ""}><span>2</span><div><strong>Index source files</strong><small>{latestRun?.detail.changed === false ? "Skipped — no changes" : "Create local searchable chunks"}</small></div></li>
                <li className={activeRepository.status === "ready" && latestRun?.detail.changed ? "done" : activeRepository.status === "ready" && latestRun?.detail.changed === false ? "skipped" : ""}><span>3</span><div><strong>Generate wiki</strong><small>{latestRun?.detail.changed === false ? "Skipped — current wiki retained" : "Write cited Markdown to disk"}</small></div></li>
              </ol>
              {latestRun && <dl className="run-details"><div><dt>Last checked</dt><dd>{formatDate(activeRepository.last_checked_at ?? latestRun.finished_at)}</dd></div><div><dt>Last updated</dt><dd>{formatDate(activeRepository.last_synced_at)}</dd></div><div><dt>Result</dt><dd>{latestRun.detail.changed === false ? "No changes" : latestRun.detail.changed ? "Updated" : latestRun.status}</dd></div>{latestRun.detail.chunkCount !== undefined && <div><dt>Chunks</dt><dd>{latestRun.detail.chunkCount}</dd></div>}{latestRun.detail.message && <div><dt>Error</dt><dd>{latestRun.detail.message}</dd></div>}</dl>}
            </> : <p className="rail-empty">Import a repository to see progress here.</p>}
          </aside>
        </div>

        <section className="ask-panel ask-dock" id="ask">
          {answer && <div className="answer-card"><div className="answer-heading"><p className="eyebrow">GROUNDED ANSWER</p><button type="button" aria-label="Close answer" onClick={() => setAnswer(null)}>×</button></div><p>{answer.answer}</p><div className="answer-citations">{answer.citations.map((citation) => <span key={citation}>▤ {citation}</span>)}</div></div>}
          <div className="ask-context"><span className="sparkle">✦</span><div><strong>{activeRepository ? `Ask about ${activeRepository.owner}/${activeRepository.name}` : "Ask your repository"}</strong><small>{activeRepository?.indexed_sha ? "Answers use the current local index, including while Codewiki checks for updates." : "Q&A becomes available after the first index completes."}</small></div></div>
          <form onSubmit={askQuestion}><input ref={questionInput} aria-label="Ask a question about the repository" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask anything about this codebase…" disabled={!activeRepository?.indexed_sha || isAnswering} /><button type="submit" disabled={!activeRepository?.indexed_sha || isAnswering || !question.trim()}>{isAnswering ? "Answering…" : "Ask →"}</button></form>
        </section>

        {showImporter && <div className="modal-backdrop"><section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><button className="modal-close" type="button" aria-label="Close import dialog" onClick={() => setShowImporter(false)}>×</button><p className="eyebrow">LOCAL FILESYSTEM MODE</p><h2 id="import-title">Import a repository</h2><p>Codewiki downloads source files, builds a local index, and writes generated pages beneath the mounted data directory.</p><form onSubmit={startImport}><label>Organization or owner<input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="roulpriya" required /></label><label>Repository name<input value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} placeholder="bolo_hackathon" required /></label><button type="submit" disabled={isSubmittingImport}>{isSubmittingImport ? "Starting…" : "Start import"}</button></form>{importMessage && <p className="import-message">{importMessage}</p>}</section></div>}
      </section>
    </main>
  );
}
