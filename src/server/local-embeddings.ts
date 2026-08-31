import { env, FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { config } from "./config.js";

let extractor: Promise<FeatureExtractionPipeline> | undefined;

async function getExtractor() {
  env.cacheDir = config.LOCAL_EMBEDDING_CACHE_DIR;
  extractor ??= pipeline("feature-extraction", config.LOCAL_EMBEDDING_MODEL, { dtype: "q8" });
  return extractor;
}

export async function embedLocally(inputs: string[]) {
  if (!inputs.length) return [];
  const model = await getExtractor();
  const output = await model(inputs, { pooling: "mean", normalize: true });
  const vectors = output.tolist() as number[][];
  if (vectors.length !== inputs.length || vectors.some((vector) => vector.some((value) => !Number.isFinite(value)))) {
    throw new Error("The local embedding model returned invalid vectors.");
  }
  return vectors;
}
