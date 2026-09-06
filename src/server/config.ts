import { z } from "zod";
import { join } from "node:path";

const schema = z.object({
  // Keep direct local runs self-contained. Docker sets DATA_DIR=/data explicitly.
  DATA_DIR: z.string().default(join(process.cwd(), "data")),
  REPOSITORY_CACHE_DIR: z.string().optional(),
  // A token can also come from an existing `gh auth login` session.
  GITHUB_TOKEN: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().optional(), OPENAI_GENERATION_MODEL: z.string().default("gpt-5.6-terra"),
  SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(24),
});
const parsed = schema.parse(process.env);
export const config = { ...parsed, REPOSITORY_CACHE_DIR: parsed.REPOSITORY_CACHE_DIR ?? join(parsed.DATA_DIR, "repositories") };
