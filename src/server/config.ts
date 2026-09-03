import { z } from "zod";
import { join } from "node:path";

const schema = z.object({
  // Keep direct local runs self-contained. Docker sets DATA_DIR=/data explicitly.
  DATA_DIR: z.string().default(join(process.cwd(), "data")),
  // A token can also come from an existing `gh auth login` session.
  GITHUB_TOKEN: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().optional(), OPENAI_GENERATION_MODEL: z.string().default("gpt-5.6-terra"),
  LOCAL_EMBEDDING_MODEL: z.string().default("jinaai/jina-embeddings-v2-base-code"),
  LOCAL_EMBEDDING_CACHE_DIR: z.string().default(join(process.cwd(), ".cache", "huggingface")),
  SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(24),
});
export const config = schema.parse(process.env);
