"use client";

import { FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MarkdownContent } from "./markdown-content";

type RepositoryStatus = "idle" | "queued" | "checking" | "running" | "ready" | "failed";

type Repository = {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  indexed_sha: string | null;
  status: RepositoryStatus;
  created_at: string;
  last_checked_at?: string | null;
  last_synced_at?: string | null;
};

type GithubRepository = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  updatedAt: string;
  importedRepositoryId: string | null;
  importStatus: RepositoryStatus | null;
};

type Citation = { path: string; start_line: number; end_line: number; evidence_index?: number; sha?: string };
type PageSummary = { id: string; slug: string; title: string; summary: string | null; created_at: string | null };
type PageDetail = PageSummary & { markdown: string; citations: Citation[] };
type SyncRun = {
  id: string;
  kind: string;
  status: "running" | "completed" | "failed";
  detail: { changed?: boolean; previousSha?: string | null; chunkCount?: number; sha?: string; message?: string };
  created_at: string;
  finished_at: string | null;
};
type WikiSection = { id: string; title: string; markdown: string; preview: string };
type AnswerSection = { heading: string; markdown: string; cites: Citation[] };
type ChatMessage = {
  id: string;
  who: "You" | "Codewiki";
  text: string;
  sections?: AnswerSection[];
  followups?: string[];
  cites: Citation[];
  failed?: boolean;
};

const BUSY: RepositoryStatus[] = ["queued", "checking", "running"];

const STARTERS = [
  "Trace the main execution flow from entry point to output.",
  "Which files and concepts should a new developer study first, and why?",
  "What TODOs, incomplete implementations, missing error handling, or test gaps are visible in the indexed evidence?",
];

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function statusCopy(status: RepositoryStatus) {
  if (status === "queued") return "Waiting to start";
  if (status === "checking") return "Checking for updates";
  if (status === "running") return "Indexing repository";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Import failed";
  return "Not indexed";
}

function relativeTime(value: string | null | undefined) {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(then);
}

function sourceUrl(repository: Repository | null, citation: Citation) {
  if (!repository) return "#";
  const ref = citation.sha ?? repository.indexed_sha ?? repository.default_branch;
  return `https://github.com/${repository.owner}/${repository.name}/blob/${ref}/${citation.path}#L${citation.start_line}-L${citation.end_line}`;
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

  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    const preview = plainText(body);
    sections.push({
      id: `section-${sections.length}`,
      title: current.title,
      markdown: body,
      preview: preview.length > 150 ? `${preview.slice(0, 147)}…` : preview,
    });
  };

  for (const line of lines) {
    if (/^#\s+/.test(line)) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      current = { title: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      introduction.push(line);
    }
  }
  flush();

  return { introduction: introduction.join("\n").trim(), sections };
}

export default function Home() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [githubRepositories, setGithubRepositories] = useState<GithubRepository[] | null>(null);
  const [activeRepositoryId, setActiveRepositoryId] = useState<string | null>(null);
  const [homeRepositoryId, setHomeRepositoryId] = useState("");
  const [homeQuestion, setHomeQuestion] = useState("");
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [page, setPage] = useState<PageDetail | null>(null);
  const [activeSectionId, setActiveSectionId] = useState("overview");
  const [runs, setRuns] = useState<SyncRun[]>([]);

  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const [askOpen, setAskOpen] = useState(false);
  const [askInput, setAskInput] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [isAnswering, setIsAnswering] = useState(false);

  const [showImporter, setShowImporter] = useState(false);
  const [owner, setOwner] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [isSubmittingImport, setIsSubmittingImport] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const [loadError, setLoadError] = useState("");

  const askField = useRef<HTMLTextAreaElement>(null);
  const paletteField = useRef<HTMLInputElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  const activeRepository = useMemo(
    () => repositories.find((repository) => repository.id === activeRepositoryId) ?? null,
    [repositories, activeRepositoryId],
  );
  const latestRun = runs[0] ?? null;
  const wiki = useMemo(() => parseWiki(page?.markdown ?? ""), [page?.markdown]);
  const jumpToSection = (id: string) => {
    setActiveSectionId(id);
    const target = document.getElementById(id);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  };
  const isBusy = activeRepository ? BUSY.includes(activeRepository.status) : false;
  const canAsk = Boolean(activeRepository?.indexed_sha);
  const readyRepositories = repositories.filter((repository) => repository.indexed_sha);
  const homeRepository = readyRepositories.find((repository) => repository.id === homeRepositoryId) ?? readyRepositories[0];

  /* ── loading ──────────────────────────────────────────────────── */

  const refreshRepositories = useCallback(async () => {
    try {
      const records = await requestJson<Repository[]>("/repositories");
      setRepositories(records);
      setLoadError("");
      return records;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load repositories.");
      return [];
    }
  }, []);

  const refreshGithubRepositories = useCallback(async () => {
    try {
      const discovery = await requestJson<{ repositories: GithubRepository[] }>("/github/repositories");
      setGithubRepositories(discovery.repositories);
    } catch {
      setGithubRepositories([]);
    }
  }, []);

  const refreshActiveRepository = useCallback(async (id: string) => {
    const [repository, runRecords] = await Promise.all([
      requestJson<Repository>(`/repositories/${id}`),
      requestJson<SyncRun[]>(`/repositories/${id}/runs`),
    ]);
    setRepositories((current) =>
      current.some((item) => item.id === repository.id)
        ? current.map((item) => (item.id === repository.id ? repository : item))
        : [repository, ...current],
    );
    setRuns(runRecords);
    if (repository.indexed_sha) {
      const records = await requestJson<PageSummary[]>(`/repositories/${id}/pages`);
      // Model-generated legacy slugs can leave multiple versions of the same guide.
      const pageRecords = records.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
        .filter((item, index, all) => all.findIndex((other) => other.title.trim().toLowerCase() === item.title.trim().toLowerCase()) === index);
      setPages(pageRecords);
      setActiveSlug((current) =>
        current && pageRecords.some((item) => item.slug === current) ? current : pageRecords[0]?.slug ?? null,
      );
    } else {
      setPages([]);
      setActiveSlug(null);
      setPage(null);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refreshRepositories();
      void refreshGithubRepositories();
      const requested = new URLSearchParams(window.location.search).get("repository");
      if (requested) setActiveRepositoryId(requested);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [refreshRepositories, refreshGithubRepositories]);

  useEffect(() => {
    const onPopState = () => setActiveRepositoryId(new URLSearchParams(window.location.search).get("repository"));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!activeRepositoryId) return;
    const load = () =>
      void refreshActiveRepository(activeRepositoryId).catch((error) =>
        setLoadError(error instanceof Error ? error.message : "Could not load repository."),
      );
    const timeout = window.setTimeout(load, 0);
    const interval = window.setInterval(
      () => void refreshActiveRepository(activeRepositoryId).catch(() => undefined),
      1800,
    );
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [activeRepositoryId, refreshActiveRepository]);

  useEffect(() => {
    if (activeRepositoryId) return;
    const interval = window.setInterval(() => void refreshRepositories(), 4000);
    return () => window.clearInterval(interval);
  }, [activeRepositoryId, refreshRepositories]);

  useEffect(() => {
    if (!activeRepositoryId || !activeSlug) return;
    const timeout = window.setTimeout(
      () =>
        void requestJson<PageDetail>(`/repositories/${activeRepositoryId}/pages/${activeSlug}`)
          .then((record) => setPage(record))
          .catch((error) => setLoadError(error instanceof Error ? error.message : "Could not load wiki page.")),
      0,
    );
    return () => window.clearTimeout(timeout);
  }, [activeRepositoryId, activeSlug]);

  /* ── navigation ───────────────────────────────────────────────── */

  const openRepository = useCallback((id: string) => {
    setActiveRepositoryId(id);
    setPage(null);
    setPages([]);
    setActiveSectionId("overview");
    setChat([]);
    setQuery("");
    window.history.pushState(null, "", `/?repository=${id}`);
  }, []);

  const openRepositoryList = useCallback(() => {
    setActiveRepositoryId(null);
    setAskOpen(false);
    setQuery("");
    window.history.pushState(null, "", "/");
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSearchOpen(false);
        setAskOpen(false);
        setShowImporter(false);
        return;
      }
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (searchOpen) window.setTimeout(() => paletteField.current?.focus(), 0);
  }, [searchOpen]);

  useEffect(() => {
    if (askOpen) window.setTimeout(() => askField.current?.focus(), 0);
  }, [askOpen]);

  useEffect(() => {
    const latest = chat.at(-1);
    if (latest?.who === "Codewiki") document.getElementById(latest.id)?.scrollIntoView({ block: "start" });
    else logEnd.current?.scrollIntoView({ block: "end" });
  }, [chat, isAnswering]);

  /* ── repository list ──────────────────────────────────────────── */

  type Row = {
    key: string;
    fullName: string;
    owner: string;
    name: string;
    description: string | null;
    meta: string;
    metaTone: string;
    repositoryId: string | null;
  };

  const rows = useMemo<Row[]>(() => {
    const importedByName = new Map(
      repositories.map((repository) => [`${repository.owner}/${repository.name}`.toLowerCase(), repository]),
    );

    const describe = (imported: Repository | undefined, remoteUpdatedAt: string | null): Pick<Row, "meta" | "metaTone"> => {
      if (imported && BUSY.includes(imported.status)) return { meta: statusCopy(imported.status), metaTone: "is-busy" };
      if (imported?.status === "failed") return { meta: "Import failed", metaTone: "is-failed" };
      if (imported) {
        const synced = relativeTime(imported.last_synced_at ?? imported.last_checked_at ?? imported.created_at);
        return { meta: synced ? `updated ${synced}` : "Not indexed", metaTone: "" };
      }
      const remote = relativeTime(remoteUpdatedAt);
      return { meta: remote ?? "—", metaTone: "is-dim" };
    };

    const collected: Row[] = [];
    const seen = new Set<string>();

    for (const remote of githubRepositories ?? []) {
      const key = remote.fullName.toLowerCase();
      seen.add(key);
      const imported = importedByName.get(key);
      collected.push({
        key,
        fullName: remote.fullName,
        owner: remote.owner,
        name: remote.name,
        description: remote.description,
        repositoryId: imported?.id ?? remote.importedRepositoryId,
        ...describe(imported, remote.updatedAt),
      });
    }

    for (const repository of repositories) {
      const key = `${repository.owner}/${repository.name}`.toLowerCase();
      if (seen.has(key)) continue;
      collected.push({
        key,
        fullName: `${repository.owner}/${repository.name}`,
        owner: repository.owner,
        name: repository.name,
        description: null,
        repositoryId: repository.id,
        ...describe(repository, null),
      });
    }

    return collected.sort((left, right) => {
      if (Boolean(left.repositoryId) !== Boolean(right.repositoryId)) return left.repositoryId ? -1 : 1;
      return left.fullName.localeCompare(right.fullName);
    });
  }, [repositories, githubRepositories]);

  const visibleRows = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (row) => row.fullName.toLowerCase().includes(term) || (row.description ?? "").toLowerCase().includes(term),
    );
  }, [rows, filter]);

  /* ── actions ──────────────────────────────────────────────────── */

  const addRepository = useCallback(
    async (repositoryOwner: string, name: string) => {
      setAdding(`${repositoryOwner}/${name}`);
      setLoadError("");
      try {
        const imported = await requestJson<Repository>("/repositories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner: repositoryOwner, name }),
        });
        setRepositories((current) => [imported, ...current.filter((item) => item.id !== imported.id)]);
        return imported;
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Import could not be started.");
        return null;
      } finally {
        setAdding(null);
      }
    },
    [],
  );

  async function startImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmittingImport(true);
    setImportMessage("");
    const imported = await addRepository(owner.trim(), repositoryName.trim());
    setIsSubmittingImport(false);
    if (!imported) {
      setImportMessage("Repository import could not be started.");
      return;
    }
    setShowImporter(false);
    setOwner("");
    setRepositoryName("");
    openRepository(imported.id);
  }

  async function reindex() {
    if (!activeRepository) return;
    try {
      await requestJson(`/repositories/${activeRepository.id}/import`, { method: "POST" });
      await refreshActiveRepository(activeRepository.id);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not start a check.");
    }
  }

  const ask = useCallback(
    async (question: string, selectedRepository?: Repository) => {
      const repository = selectedRepository ?? activeRepository;
      if (!repository?.indexed_sha) return;
      const trimmed = question.trim();
      if (!trimmed || isAnswering) return;

      setAskInput("");
      setChat((current) => [...current, { id: `q-${Date.now()}`, who: "You", text: trimmed, cites: [] }]);
      setIsAnswering(true);
      try {
        const data = await requestJson<{
          summary: string;
          sections: Array<{ heading: string; markdown: string; citedChunkIndexes: number[] }>;
          followups: string[];
          citations: Array<{ path: string; startLine: number; endLine: number; sha?: string }>;
        }>(`/repositories/${repository.id}/questions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed }),
          signal: AbortSignal.timeout(180_000),
        });
        const cites: Citation[] = data.citations.map((citation, evidenceIndex) => ({
          path: citation.path,
          start_line: citation.startLine,
          end_line: citation.endLine,
          sha: citation.sha,
          evidence_index: evidenceIndex,
        }));
        setChat((current) => [
          ...current,
          {
            id: `a-${Date.now()}`,
            who: "Codewiki",
            text: data.summary,
            sections: data.sections.map((section) => ({
              heading: section.heading,
              markdown: section.markdown,
              cites: section.citedChunkIndexes.map((chunkIndex) => cites[chunkIndex]).filter((cite): cite is Citation => Boolean(cite)),
            })),
            followups: data.followups,
            cites,
          },
        ]);
      } catch (error) {
        setAskInput(trimmed);
        setChat((current) => [
          ...current,
          {
            id: `a-${Date.now()}`,
            who: "Codewiki",
            text: error instanceof Error && error.name === "TimeoutError" ? "The answer took too long. Please try again." : error instanceof Error ? error.message : "Question could not be answered.",
            cites: [],
            failed: true,
          },
        ]);
      } finally {
        setIsAnswering(false);
      }
    },
    [activeRepository, isAnswering],
  );

  /* ── search ───────────────────────────────────────────────────── */

  type Hit = { id: string; title: string; path: string; go: () => void };

  const hits = useMemo<Hit[]>(() => {
    const term = query.trim().toLowerCase();
    const match = (value: string) => !term || value.toLowerCase().includes(term);

    if (!activeRepositoryId) {
      return rows
        .filter((row) => match(row.fullName) || match(row.description ?? ""))
        .slice(0, 40)
        .map((row) => ({
          id: row.key,
          title: row.description || row.fullName,
          path: row.fullName,
          go: () => {
            if (row.repositoryId) openRepository(row.repositoryId);
            else void addRepository(row.owner, row.name);
          },
        }));
    }

    const collected: Hit[] = [];
    for (const summary of pages) {
      if (match(summary.title) || match(summary.summary ?? "")) {
        collected.push({
          id: `page-${summary.id}`,
          title: summary.title,
          path: summary.slug,
          go: () => {
            setActiveSlug(summary.slug);
            setActiveSectionId("overview");
          },
        });
      }
    }
    for (const section of wiki.sections) {
      if (match(section.title) || match(section.preview)) {
        collected.push({
          id: `hit-${section.id}`,
          title: section.title,
          path: `${page?.title ?? "Wiki"} › ${section.title}`,
          go: () => setActiveSectionId(section.id),
        });
      }
    }
    for (const citation of page?.citations ?? []) {
      if (match(citation.path)) {
        collected.push({
          id: `cite-${citation.path}-${citation.start_line}`,
          title: citation.path.split("/").pop() ?? citation.path,
          path: `${citation.path}:${citation.start_line}`,
          go: () => window.open(sourceUrl(activeRepository, citation), "_blank", "noreferrer"),
        });
      }
    }
    return collected.slice(0, 40);
  }, [query, activeRepositoryId, rows, pages, wiki.sections, page, activeRepository, openRepository, addRepository]);

  /* ── render ───────────────────────────────────────────────────── */

  const headerMeta = (() => {
    if (!activeRepository) return null;
    if (isBusy) return { text: statusCopy(activeRepository.status), tone: "is-busy" };
    if (activeRepository.status === "failed") {
      return { text: latestRun?.detail.message ?? "Import failed", tone: "is-failed" };
    }
    const synced = relativeTime(activeRepository.last_synced_at ?? activeRepository.last_checked_at);
    return synced ? { text: `updated ${synced}`, tone: "" } : { text: "not indexed", tone: "" };
  })();

  const citations = page?.citations ?? [];

  return (
    <>
      <header className="topbar">
        <button className="topbar-brand" type="button" onClick={openRepositoryList}>
          Codewiki
        </button>

        {activeRepository && (
          <span className="crumb">
            <span className="crumb-sep">/</span>
            <button className="crumb-repo" type="button" onClick={openRepositoryList}>
              {activeRepository.owner}/{activeRepository.name}
            </button>
            {headerMeta && <span className={`crumb-meta ${headerMeta.tone}`}>{headerMeta.text}</span>}
          </span>
        )}

        <div className="topbar-search">
          <label className="sr-only" htmlFor="topbar-search">
            Search
          </label>
          <input
            className="input"
            id="topbar-search"
            type="text"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setSearchOpen(true)}
          />
        </div>

        <div className="topbar-actions">
          <a className="btn btn-quiet btn-sm" href="/settings">AI settings</a>
          {activeRepository && (
            <button className="btn btn-outline btn-sm" type="button" disabled={isBusy} onClick={() => void reindex()}>
              {isBusy ? "Checking…" : "Check now"}
            </button>
          )}
          {activeRepository && (
            <button className="btn btn-accent btn-sm" type="button" disabled={!canAsk} onClick={() => setAskOpen((open) => !open)}>
              {askOpen ? "View wiki" : "Ask"}
            </button>
          )}
        </div>
      </header>

      {isBusy && (
        <div className="topbar-progress" role="progressbar" aria-label="Indexing in progress">
          <i />
        </div>
      )}

      {loadError && (
        <div className="banner" role="alert">
          {loadError}
          <button type="button" onClick={() => void refreshRepositories()}>
            Try again
          </button>
        </div>
      )}

      {activeRepositoryId ? (
        <div className="wiki">
          <aside className="wiki-nav">
            <p className="wiki-nav-label">Contents</p>
            {pages.length ? (
              pages.map((summary) => (
                <Fragment key={summary.id}>
                  <button
                    className={`nav-item ${summary.slug === activeSlug && activeSectionId === "overview" ? "is-active" : ""}`}
                    type="button"
                    onClick={() => {
                      setActiveSlug(summary.slug);
                      jumpToSection("overview");
                    }}
                  >
                    {summary.title}
                  </button>
                  {summary.slug === activeSlug &&
                    wiki.sections.map((section) => (
                      <button
                        className={`nav-item nav-sub ${section.id === activeSectionId ? "is-active" : ""}`}
                        key={section.id}
                        type="button"
                        onClick={() => jumpToSection(section.id)}
                      >
                        {section.title}
                      </button>
                    ))}
                </Fragment>
              ))
            ) : (
              <p className="nav-item">{isBusy ? "Building…" : "No pages yet"}</p>
            )}
          </aside>

          <main className={`wiki-main ${askOpen ? "wiki-main-ask" : ""}`}>
            {askOpen ? (
              <section className="ask-workspace" aria-labelledby="ask-workspace-title">
                <div className="ask-workspace-heading">
                  <p className="eyebrow">Ask {activeRepository?.owner}/{activeRepository?.name}</p>
                  <h1 className="doc-title" id="ask-workspace-title">What would you like to know?</h1>
                  <p className="doc-lede">Ask anything across this repository. Every answer is grounded in the indexed source.</p>
                </div>

                <form
                  className="ask-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void ask(askInput);
                  }}
                >
                  <label className="sr-only" htmlFor="workspace-ask">Ask a question</label>
                  <textarea
                    className="ask-composer-input"
                    id="workspace-ask"
                    ref={askField}
                    rows={5}
                    placeholder="Ask anything about this codebase…"
                    value={askInput}
                    disabled={!canAsk || isAnswering}
                    onChange={(event) => setAskInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void ask(askInput);
                      }
                    }}
                  />
                  <div className="ask-composer-footer">
                    <span>⌘↵ to ask</span>
                    <button className="ask-send" type="submit" disabled={!canAsk || isAnswering || !askInput.trim()} aria-label="Ask question">
                      ↑
                    </button>
                  </div>
                </form>

                {chat.length > 0 && (
                  <section className="ask-results" aria-label="Conversation" aria-live="polite">
                    {chat.map((message) => (
                      <div className="ask-result" id={message.id} key={message.id}>
                        <span className="msg-who">{message.who}</span>
                        {message.sections && message.sections.length > 0 ? (
                          <div className="msg-structured">
                            <div className="msg-summary"><MarkdownContent markdown={message.text} /></div>
                            {message.sections.map((section, sectionIndex) => (
                              <details className="msg-section" key={`${message.id}-s-${sectionIndex}`} open>
                                <summary className="msg-section-heading">{section.heading}</summary>
                                <div className="msg-section-body">
                                  <MarkdownContent markdown={section.markdown} />
                                  {section.cites.length > 0 && (
                                    <span className="msg-cites">
                                      {section.cites.map((citation, index) => (
                                        <a className="msg-cite" key={`${message.id}-${sectionIndex}-${citation.path}-${citation.start_line}`} href={sourceUrl(activeRepository, citation)} target="_blank" rel="noreferrer">
                                          [{citation.evidence_index ?? index}] {citation.path}:{citation.start_line}–{citation.end_line}
                                        </a>
                                      ))}
                                    </span>
                                  )}
                                </div>
                              </details>
                            ))}
                            {message.followups && message.followups.length > 0 && (
                              <div className="msg-followups">
                                {message.followups.map((followup) => (
                                  <button className="chip" key={followup} type="button" disabled={!canAsk || isAnswering} onClick={() => void ask(followup)}>
                                    {followup}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <>
                            <div className={`msg-text ${message.who === "You" ? "is-you" : ""} ${message.failed ? "is-error" : ""}`}>
                              <MarkdownContent markdown={message.text} />
                            </div>
                            {message.cites.length > 0 && (
                              <span className="msg-cites">
                                {message.cites.map((citation, index) => (
                                  <a className="msg-cite" key={`${message.id}-${citation.path}-${citation.start_line}`} href={sourceUrl(activeRepository, citation)} target="_blank" rel="noreferrer">
                                    [{citation.evidence_index ?? index}] {citation.path}:{citation.start_line}–{citation.end_line}
                                  </a>
                                ))}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    {isAnswering && <p className="ask-thinking">Reading the indexed source…</p>}
                    <div ref={logEnd} />
                  </section>
                )}

                {chat.length === 0 && (
                  <>
                    <div className="ask-suggestions">
                      {STARTERS.map((prompt) => (
                        <button className="chip" key={prompt} type="button" disabled={!canAsk || isAnswering} onClick={() => void ask(prompt)}>
                          {prompt}
                        </button>
                      ))}
                    </div>
                    <section className="recent-pages" aria-labelledby="recent-pages-title">
                      <h2 className="recent-pages-title" id="recent-pages-title">Newest articles</h2>
                      <div className="recent-page-grid">
                        {pages.slice(0, 6).map((summary) => (
                          <button className="recent-page" key={summary.id} type="button" onClick={() => { setActiveSlug(summary.slug); setActiveSectionId("overview"); setAskOpen(false); }}>
                            <span className="recent-page-title">{summary.title}</span>
                            <span className="recent-page-summary">{summary.summary ?? "Open this generated wiki page."}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  </>
                )}
              </section>
            ) : page ? (
              <article className="architecture-article">
                <header id="overview" className="article-header" tabIndex={-1}>
                  <p className="eyebrow">Repository guide</p>
                  <h1 className="doc-title">{page.title}</h1>
                  {page.summary && <p className="doc-lede">{page.summary}</p>}
                  <div className="article-meta">
                    <span>{wiki.sections.length} sections</span>
                    {citations.length > 0 && <a href="#sources">{citations.length} source references</a>}
                    {page.created_at && <span>Updated {relativeTime(page.created_at)}</span>}
                  </div>
                </header>
                <form className="overview-ask" onSubmit={(event) => { event.preventDefault(); setAskOpen(true); void ask(askInput); }}>
                  <label htmlFor="overview-question">Ask this repository</label>
                  <p>Understand how it works, trace a flow, or find the code you need.</p>
                  <div className="overview-ask-input">
                    <input id="overview-question" className="input" placeholder="How does this project work?" value={askInput} disabled={!canAsk || isAnswering} onChange={(event) => setAskInput(event.target.value)} />
                    <button className="btn btn-accent" type="submit" disabled={!canAsk || isAnswering || !askInput.trim()}>Ask →</button>
                  </div>
                  <div className="overview-ask-starters">
                    {["Trace the main execution flow.", "Where should I start reading the code?"].map((prompt) => (
                      <button key={prompt} className="chip" type="button" disabled={!canAsk || isAnswering} onClick={() => { setAskOpen(true); void ask(prompt); }}>{prompt}</button>
                    ))}
                  </div>
                  <span className="overview-ask-note">{canAsk ? "Answers grounded in your repository, with source references." : "Ask becomes available when the first index is ready."}</span>
                </form>
                <div className="mobile-contents">
                  <label htmlFor="section-jump">Jump to section</label>
                  <select id="section-jump" className="input" value={activeSectionId} onChange={(event) => jumpToSection(event.target.value)}>
                    <option value="overview">Overview</option>
                    {wiki.sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
                  </select>
                </div>
                {wiki.introduction && <MarkdownContent markdown={wiki.introduction} />}
                {wiki.sections.map((section, index) => (
                  <section className="article-section" id={section.id} key={section.id} tabIndex={-1} aria-labelledby={`${section.id}-title`}>
                    <h2 id={`${section.id}-title`}><span className="section-number">{String(index + 1).padStart(2, "0")}</span>{section.title}</h2>
                    <MarkdownContent markdown={section.markdown} />
                  </section>
                ))}
                <div className="article-question">
                  <div><strong>Go deeper into the code</strong><p>Ask a question and explore the supporting source.</p></div>
                  <button className="btn btn-outline btn-sm" type="button" disabled={!canAsk} onClick={() => setAskOpen(true)}>Ask this repository →</button>
                </div>
              </article>
            ) : (
              <>
                <h1 className="doc-title">
                  {activeRepository ? statusCopy(activeRepository.status) : "Loading repository…"}
                </h1>
                <p className="doc-lede">
                  {activeRepository?.status === "queued"
                    ? "The import request is waiting to start."
                    : activeRepository?.status === "checking"
                      ? "Codewiki is comparing the remote default branch with the local snapshot."
                      : activeRepository?.status === "running"
                        ? "Codewiki found a new commit and is updating the local index and wiki."
                        : activeRepository?.status === "failed"
                          ? (latestRun?.detail.message ?? "The import failed. Try running the check again.")
                          : "This repository has no wiki yet. Run a check to build one."}
                </p>
                {activeRepository && !isBusy && (
                  <button className="btn btn-accent" type="button" onClick={() => void reindex()}>
                    Check now
                  </button>
                )}
              </>
            )}

            {!askOpen && citations.length > 0 && (
              <div className="sources" id="sources">
                <span className="sources-label">Sources</span>
                {citations.map((citation, index) => (
                  <a
                    className="source"
                    key={`${citation.path}-${citation.start_line}`}
                    href={sourceUrl(activeRepository, citation)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="source-n">{citation.evidence_index ?? index}</span>
                    <span className="source-path">{citation.path}</span>
                    <span className="source-lines">
                      {citation.start_line}–{citation.end_line}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </main>
        </div>
      ) : (
        <main className="page home-page">
          <section className="home-intro">
            <p className="eyebrow">Your code, explained</p>
            <h1 className="page-title">What do you want to understand?</h1>
            <p className="page-lede">Ask your codebase a question. Get an answer with the files and lines behind it.</p>
            {homeRepository ? (
              <form className="home-composer" onSubmit={(event) => {
                event.preventDefault();
                if (!homeQuestion.trim() || isAnswering) return;
                openRepository(homeRepository.id);
                setAskOpen(true);
                void ask(homeQuestion, homeRepository);
                setHomeQuestion("");
              }}>
                <label className="home-repo-label" htmlFor="home-repository">Ask in</label>
                <select id="home-repository" className="input" value={homeRepository.id} onChange={(event) => setHomeRepositoryId(event.target.value)}>
                  {readyRepositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.owner}/{repository.name}</option>)}
                </select>
                <label className="sr-only" htmlFor="home-question">Your question</label>
                <textarea id="home-question" placeholder="How does authentication work in this project?" rows={3} value={homeQuestion} onChange={(event) => setHomeQuestion(event.target.value)} />
                <div className="home-composer-footer"><span>Answers reference the indexed source.</span><button className="btn btn-accent" type="submit" disabled={!homeQuestion.trim() || isAnswering}>Ask Codewiki →</button></div>
                <div className="overview-ask-starters">
                  {["Trace the main execution flow.", "Where should I start reading the code?", "How is data stored?"].map((prompt) => <button className="chip" type="button" key={prompt} onClick={() => { setHomeQuestion(prompt); document.getElementById("home-question")?.focus(); }}>{prompt}</button>)}
                </div>
              </form>
            ) : (
              <div className="home-composer"><h2>Add a repository to start asking</h2><p>{repositories.length ? "Your repositories are not ready for questions yet. Open one below to check its import status." : "Choose a GitHub repository. Codewiki will index its source and prepare it for questions."}</p><a className="btn btn-accent" href="/discover">Discover repositories →</a></div>
            )}
          </section>
          <div className="home-library-heading"><h2>Your repositories</h2><a href="/discover">Discover more →</a></div>

          <div className="repos-toolbar">
            <label className="sr-only" htmlFor="repository-filter">
              Filter repositories
            </label>
            <input
              className="input"
              id="repository-filter"
              type="text"
              placeholder="Filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              className="btn btn-accent btn-sm"
              type="button"
              onClick={() => {
                setShowImporter(true);
                setImportMessage("");
              }}
            >
              Add repository
            </button>
          </div>

          <div className="rows">
            {visibleRows.filter((row) => row.repositoryId).map((row) => (
              <div className="repo-row" key={row.key}>
                <span className="repo-row-main">
                  <span className="repo-row-name">{row.fullName}</span>
                  <span className="repo-row-desc">{row.description || "No description provided."}</span>
                </span>
                <span className={`repo-row-meta ${row.metaTone}`}>{row.meta}</span>
                {row.repositoryId ? (
                  <button
                    className="btn btn-outline btn-sm"
                    type="button"
                    onClick={() => openRepository(row.repositoryId as string)}
                  >
                    Open
                  </button>
                ) : (
                  <button
                    className="btn btn-accent btn-sm"
                    type="button"
                    disabled={adding === row.fullName}
                    onClick={() => void addRepository(row.owner, row.name)}
                  >
                    {adding === row.fullName ? "Adding…" : "Add"}
                  </button>
                )}
              </div>
            ))}
            {visibleRows.filter((row) => row.repositoryId).length === 0 && (
              <p className="empty-note">
                {githubRepositories === null
                  ? "Loading repositories…"
                  : filter
                    ? "No repository matches that filter."
                    : "No repositories yet. Add one to build its wiki."}
              </p>
            )}
          </div>
        </main>
      )}

      {searchOpen && (
        <div className="palette-scrim">
          <button
            className="scrim-dismiss"
            type="button"
            aria-label="Close search"
            onClick={() => setSearchOpen(false)}
          />
          <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
            <input
              className="palette-input"
              ref={paletteField}
              type="text"
              placeholder={activeRepositoryId ? "Search this repository" : "Search repositories"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="palette-list">
              {hits.map((hit) => (
                <button
                  className="palette-hit"
                  key={hit.id}
                  type="button"
                  onClick={() => {
                    hit.go();
                    setSearchOpen(false);
                  }}
                >
                  <span className="palette-hit-title">{hit.title}</span>
                  <span className="palette-hit-path">{hit.path}</span>
                </button>
              ))}
              {hits.length === 0 && <p className="palette-empty">Nothing matches “{query}”.</p>}
            </div>
          </div>
        </div>
      )}

      {showImporter && (
        <div className="dialog-scrim">
          <button
            className="scrim-dismiss"
            type="button"
            aria-label="Cancel"
            onClick={() => setShowImporter(false)}
          />
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <h2 className="dialog-title" id="import-title">
              Add a repository
            </h2>
            <p className="dialog-note">
              Codewiki reads the source with your access token, builds a local index, and writes the wiki beneath your
              data folder.
            </p>
            <form onSubmit={startImport}>
              <label className="field">
                <span>Owner or organization</span>
                <input
                  className="input"
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                  placeholder="roulpriya"
                  required
                />
              </label>
              <label className="field">
                <span>Repository name</span>
                <input
                  className="input"
                  value={repositoryName}
                  onChange={(event) => setRepositoryName(event.target.value)}
                  placeholder="codewiki"
                  required
                />
              </label>
              {importMessage && <p className="dialog-message">{importMessage}</p>}
              <div className="dialog-actions">
                <button className="btn btn-quiet btn-sm" type="button" onClick={() => setShowImporter(false)}>
                  Cancel
                </button>
                <button className="btn btn-accent btn-sm" type="submit" disabled={isSubmittingImport}>
                  {isSubmittingImport ? "Starting…" : "Add repository"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
