import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { config } from "./config.js";

type Work = { id: string; inputs: string[] };

let extractor: Promise<FeatureExtractionPipeline> | undefined;

async function getExtractor() {
  env.cacheDir = config.LOCAL_EMBEDDING_CACHE_DIR;
  extractor ??= pipeline("feature-extraction", config.LOCAL_EMBEDDING_MODEL, { dtype: "q8" });
  return extractor;
}

onmessage = async ({ data }: MessageEvent<Work>) => {
  try {
    const model = await getExtractor();
    const output = await model(data.inputs, { pooling: "mean", normalize: true });
    const vectors = output.tolist() as number[][];
    if (vectors.length !== data.inputs.length || vectors.some((vector) => !vector.length || vector.length !== vectors[0]?.length || vector.some((value) => !Number.isFinite(value)))) {
      throw new Error("The local embedding model returned invalid vectors.");
    }
    postMessage({ id: data.id, vectors });
  } catch (error) {
    extractor = undefined;
    postMessage({ id: data.id, error: error instanceof Error ? error.message : "Local embedding worker failed." });
  }
};
