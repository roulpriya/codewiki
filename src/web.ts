import { extname, join, normalize } from "node:path";
import { handleApi } from "./server/api.js";

const root = join(import.meta.dir, "..", "dist", "web");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codewiki — repository knowledge, kept current</title><meta name="description" content="A living, cited wiki for your codebase."><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/client.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>`;

function staticFile(pathname: string) {
  const path = normalize(join(root, pathname));
  return path.startsWith(`${root}/`) ? Bun.file(path) : null;
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

Bun.serve({
  hostname: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, url.pathname.slice(4) || "/");
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const file = staticFile(url.pathname);
      if (file && await file.exists()) {
        const contentType = contentTypes[extname(url.pathname)];
        return new Response(file, { headers: contentType ? { "Content-Type": contentType } : {} });
      }
    }
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
});
