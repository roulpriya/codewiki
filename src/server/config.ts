import { z } from "zod";

const schema = z.object({
  DATA_DIR: z.string().default("/data"),
  // A token can also come from an existing `gh auth login` session.
  GITHUB_TOKEN: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().optional(), OPENAI_GENERATION_MODEL: z.string().default("gpt-5.6-terra"),
  LOCAL_EMBEDDING_MODEL: z.string().default("jinaai/jina-embeddings-v2-base-code"),
  LOCAL_EMBEDDING_CACHE_DIR: z.string().default(".cache/huggingface"),
  SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  API_PORT: z.coerce.number().default(3001),
});
export const config = schema.parse(process.env);
