"use client";

import { useCallback, useEffect, useState } from "react";

type Status = {
  activeProvider: "codex" | "claude" | "openai" | null;
  codex: { available: boolean; message: string };
  claude: { available: boolean; message: string };
  openai: { available: boolean; source: "environment" | "local" | null };
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export default function SettingsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [connecting, setConnecting] = useState<"codex" | "claude" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await requestJson<Status>("/ai/status");
      setStatus(next);
      if (connecting && next[connecting].available) setConnecting(null);
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "AI provider status could not be loaded."); }
  }, [connecting]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeout);
  }, [refresh]);
  useEffect(() => {
    if (!connecting) return;
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [connecting, refresh]);
  async function connect(provider: "codex" | "claude") {
    setConnecting(provider); setMessage("");
    try { setMessage((await requestJson<{ message: string }>(`/ai/${provider}/login`, { method: "POST" })).message); }
    catch (error) { setConnecting(null); setMessage(error instanceof Error ? error.message : "Sign-in could not be started."); }
  }

  async function saveKey() {
    setMessage("");
    try {
      await requestJson<unknown>("/ai/openai-key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }) });
      setApiKey(""); setMessage("OpenAI API key saved on this machine."); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "OpenAI API key could not be saved."); }
  }

  return <>
    <header className="topbar">
      <a className="topbar-brand" href="/">Codewiki</a>
      <span className="crumb"><span className="crumb-sep">/</span><span className="crumb-repo">AI settings</span></span>
      <div className="topbar-actions"><a className="btn btn-outline btn-sm" href="/">Back to wiki</a></div>
    </header>
    <main className="page settings-page">
      <h1 className="page-title">AI provider</h1>
      <p className="page-lede">Codewiki uses the first connected provider: Codex, Claude Code, then OpenAI API.</p>
      {message && <div className="banner" role="status">{message}</div>}
      <section className="settings-card">
        <h2>Codex / ChatGPT subscription</h2>
        <p>{status?.codex.message ?? "Checking Codex…"}</p>
        <button className="btn btn-accent" type="button" disabled={status?.codex.available || connecting !== null} onClick={() => void connect("codex")}>{connecting === "codex" ? "Waiting for ChatGPT…" : status?.codex.available ? "Connected" : "Connect Codex"}</button>
      </section>
      <section className="settings-card">
        <h2>Claude Code subscription</h2>
        <p>{status?.claude.message ?? "Checking Claude Code…"}</p>
        <button className="btn btn-outline" type="button" disabled={status?.claude.available || connecting !== null} onClick={() => void connect("claude")}>{connecting === "claude" ? "Waiting for Claude…" : status?.claude.available ? "Connected" : "Connect Claude"}</button>
      </section>
      <section className="settings-card">
        <h2>OpenAI API key</h2>
        <p>{status?.openai.available ? `Connected from ${status.openai.source === "environment" ? "OPENAI_API_KEY" : "local settings"}.` : "Use this when no subscription provider is available. ChatGPT subscriptions do not include API usage."}</p>
        <label className="sr-only" htmlFor="openai-key">OpenAI API key</label>
        <div className="settings-key-row">
          <input className="input" id="openai-key" type="password" autoComplete="off" placeholder="sk-…" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          <button className="btn btn-outline" type="button" disabled={!apiKey.trim()} onClick={() => void saveKey()}>Save key</button>
        </div>
        <p className="empty-note">Saved only in this app’s local data directory with owner-only file permissions. An environment key always takes precedence.</p>
      </section>
    </main>
  </>;
}
