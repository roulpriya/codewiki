import { z } from "zod";

const schema = z.object({
  DATA_DIR: z.string().default("/data"),
  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required for personal mode."),
  OPENAI_API_KEY: z.string().optional(), OPENAI_GENERATION_MODEL: z.string().default("gpt-5.6-terra"), OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  API_PORT: z.coerce.number().default(3001),
});
export const config = schema.parse(process.env);
