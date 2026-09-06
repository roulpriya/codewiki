import { test, expect } from "bun:test";
import { splitFile, cosineSimilarity, retrieve, overviewEvidence } from "../src/server/retrieval.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/app/markdown-content.tsx";

const chunk = (path, content, embedding = null) => ({ id: path, path, content, startLine: 1, endLine: 1, contentHash: path, embedding });

test("chunks preserve line coordinates, overlap and bound pathological lines", () => {
  const lines = Array.from({ length: 180 }, (_, i) => `line ${i + 1}`);
  const chunks = splitFile("main.ts", lines.join("\n"));
  for (const part of chunks) expect(part.content).toBe(lines.slice(part.startLine - 1, part.endLine).join("\n"));
  expect(chunks[1].startLine).toBe(73);
  expect(chunks.at(-1).endLine).toBe(180);
  expect(splitFile("huge.js", "x".repeat(19000)).every((part) => part.content.length <= 6000)).toBe(true);
  expect(splitFile("empty.ts", "\n")).toEqual([]);
});

test("invalid vector dimensions cannot produce false similarity", () => {
  expect(cosineSimilarity([1], [1, 2])).toBe(0);
  expect(cosineSimilarity([NaN], [1])).toBe(0);
  expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
});

test("lexical fallback finds paths and camelCase symbols without embedding service", () => {
  const rows = [chunk("src/login.ts", "function refreshToken() {}"), chunk("readme.md", "A project")];
  expect(retrieve(rows, "refresh token")[0].path).toBe("src/login.ts");
  expect(retrieve(rows, "login")[0].path).toBe("src/login.ts");
  expect(retrieve(rows, "nonexistent")).toEqual([]);
});

test("overview evidence includes multiple files and honors context budget", () => {
  const rows = [...Array.from({ length: 100 }, () => chunk("a.ts", "x".repeat(100))), chunk("README.md", "Purpose"), chunk("src/web.ts", "Entry")];
  const selected = overviewEvidence(rows, 800);
  expect(selected[0].path).toBe("README.md");
  expect(selected.some((row) => row.path === "src/web.ts")).toBe(true);
  expect(selected.reduce((sum, row) => sum + row.content.length + row.path.length + 80, 0)).toBeLessThanOrEqual(800);
});

test("Markdown renders GFM and inline formatting without executable HTML or images", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, { markdown: '**bold** and `code`\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![track](https://example.com/pixel)' }));
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<table>");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("<img");
});
