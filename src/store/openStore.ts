import { FileVectorStore } from "./fileStore.js";
import type { VectorStore } from "./types.js";

export async function openVectorStore(options: {
  indexDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<VectorStore> {
  const env = options.env || process.env;
  const backend = (env.PLAUD_VECTOR_BACKEND || "lancedb").toLowerCase();
  if (backend === "file" || backend === "json") {
    return new FileVectorStore(options.indexDir);
  }
  try {
    const { LanceVectorStore } = await import("./lancedbStore.js");
    return new LanceVectorStore(options.indexDir);
  } catch {
    return new FileVectorStore(options.indexDir);
  }
}
