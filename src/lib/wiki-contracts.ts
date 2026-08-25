export type SourceCitation = {
  repositoryId: string;
  snapshotSha: string;
  path: string;
  startLine: number;
  endLine: number;
  chunkId: string;
};

export type GeneratedPage = {
  slug: string;
  title: string;
  summary: string;
  markdown: string;
  citations: SourceCitation[];
};

export type IndexJob = {
  repositoryId: string;
  targetSha: string;
  trigger: "initial-import" | "merged-pr" | "nightly-reconcile";
  idempotencyKey: string;
};

export type ObjectStore = {
  putText(key: string, value: string, contentType: string): Promise<void>;
  getText(key: string): Promise<string>;
};

export const rawImportKey = (repositoryId: string, sha: string) =>
  `repositories/${repositoryId}/raw/imports/${sha}/manifest.json`;

export const wikiRevisionKey = (repositoryId: string, revisionId: string, slug: string) =>
  `repositories/${repositoryId}/wiki/revisions/${revisionId}/${slug}.md`;
