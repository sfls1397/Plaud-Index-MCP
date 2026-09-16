export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

export interface Embedder {
  readonly modelId: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

function normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) {
    sum += v * v;
  }
  const mag = Math.sqrt(sum) || 1;
  return vec.map((v) => v / mag);
}

/**
 * Deterministic local embedder for tests. Not used in production.
 */
export function createHashEmbedder(modelId = "mock/hash-minilm", dim = EMBEDDING_DIM): Embedder {
  return {
    modelId,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vec = new Array(dim).fill(0);
        const input = text || " ";
        for (let i = 0; i < input.length; i++) {
          const code = input.charCodeAt(i);
          vec[i % dim] += ((code * (i + 1)) % 97) / 50 - 0.5;
          vec[(i * 7) % dim] += ((code * 13) % 53) / 80;
        }
        return normalize(vec);
      });
    }
  };
}

export async function createXenovaEmbedder(
  modelId = DEFAULT_EMBED_MODEL
): Promise<Embedder> {
  const { pipeline } = await import("@xenova/transformers");
  const extractor = await pipeline("feature-extraction", modelId);
  return {
    modelId,
    dim: EMBEDDING_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      const result = await extractor(texts, { pooling: "mean", normalize: true });
      const data = Array.from(result.data as ArrayLike<number>);
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        const start = i * EMBEDDING_DIM;
        out.push(Array.from(data.slice(start, start + EMBEDDING_DIM)));
      }
      return out;
    }
  };
}

export async function createEmbedder(options: {
  env?: NodeJS.ProcessEnv;
  modelId?: string;
} = {}): Promise<Embedder> {
  const env = options.env || process.env;
  const modelId = options.modelId || env.PLAUD_EMBED_MODEL || DEFAULT_EMBED_MODEL;
  if (env.PLAUD_EMBEDDER === "mock" || env.PLAUD_EMBEDDER === "hash") {
    return createHashEmbedder(modelId);
  }
  return createXenovaEmbedder(modelId);
}
