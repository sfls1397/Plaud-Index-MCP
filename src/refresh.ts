import { createHash } from "node:crypto";
import { buildIndexText, chunkText } from "./chunk.js";
import type { Embedder } from "./embed.js";
import { fingerprintRecord, type PlaudClient, type PlaudFileRecord } from "./plaud/types.js";
import type { StoredChunk, VectorStore } from "./store/types.js";
import { isAuthExpiredError, isTransportError } from "./auth/errors.js";

export interface RefreshResult {
  examined: number;
  upserted: number;
  skipped: number;
  deleted: number;
  fullReindex: boolean;
  modelId: string;
}

export async function refreshIndex(options: {
  client: PlaudClient;
  store: VectorStore;
  embedder: Embedder;
  log?: (msg: string) => void;
  pageSize?: number;
  maxPages?: number;
}): Promise<RefreshResult> {
  const log = options.log || ((msg) => console.error(msg));
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 200;

  const meta = await options.store.getMetadata();
  const fullReindex = Boolean(meta.embedModel) && meta.embedModel !== options.embedder.modelId;
  if (fullReindex) {
    log(
      `Embed model changed (${meta.embedModel} → ${options.embedder.modelId}). Full re-index required.`
    );
  }

  const existing = fullReindex ? new Map<string, string>() : await options.store.listFingerprints();
  const seen = new Set<string>();
  const rebuilt: StoredChunk[] = [];
  let upserted = 0;
  let skipped = 0;
  let examined = 0;

  for (let page = 1; page <= maxPages; page++) {
    const files = await options.client.listFiles({ page, pageSize });
    if (files.length === 0) {
      break;
    }
    for (const summary of files) {
      examined += 1;
      seen.add(summary.id);
      let record: PlaudFileRecord;
      try {
        record = await options.client.loadRecord(summary.id);
      } catch (err) {
        if (isAuthExpiredError(err) || isTransportError(err)) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        log(`Skipping ${summary.id}: ${message}`);
        continue;
      }
      const fingerprint = hashFingerprint(fingerprintRecord(record));
      if (!fullReindex && existing.get(summary.id) === fingerprint) {
        skipped += 1;
        continue;
      }
      const chunks = await chunksForRecord(record, fingerprint, options.embedder);
      if (fullReindex) {
        rebuilt.push(...chunks);
      } else {
        await options.store.upsertChunks(chunks);
      }
      upserted += 1;
    }
    if (files.length < pageSize) {
      break;
    }
  }

  let deleted = 0;
  if (fullReindex) {
    await options.store.replaceAll(rebuilt, {
      embedModel: options.embedder.modelId,
      embedDim: options.embedder.dim,
      schemaVersion: 1
    });
  } else {
    for (const fileId of existing.keys()) {
      if (!seen.has(fileId)) {
        await options.store.deleteFile(fileId);
        deleted += 1;
      }
    }
  }

  const ready = await options.store.isReady();
  await options.store.updateMetadata({
    embedModel: options.embedder.modelId,
    embedDim: options.embedder.dim,
    populated: ready,
    schemaVersion: 1
  });

  return {
    examined,
    upserted,
    skipped,
    deleted,
    fullReindex,
    modelId: options.embedder.modelId
  };
}

export async function chunksForRecord(
  record: PlaudFileRecord,
  fingerprint: string,
  embedder: Embedder
): Promise<StoredChunk[]> {
  const parts: { kind: StoredChunk["kind"]; text: string }[] = [];
  parts.push({ kind: "title", text: record.name });
  if (record.transcriptText) {
    for (const chunk of chunkText(buildIndexText(record.name, record.transcriptText))) {
      parts.push({ kind: "transcript", text: chunk.text });
    }
  }
  for (const note of record.notes) {
    const body = note.markdown || "";
    if (!body) {
      continue;
    }
    const labeled = note.title ? `${note.title}\n\n${body}` : body;
    for (const chunk of chunkText(buildIndexText(record.name, labeled))) {
      parts.push({ kind: "note", text: chunk.text });
    }
  }

  const unique = parts.filter((p) => p.text.trim());
  const vectors = await embedder.embed(unique.map((p) => p.text));
  return unique.map((part, i) => ({
    id: `${record.id}:${i}`,
    fileId: record.id,
    title: record.name,
    createdAt: record.createdAt,
    durationMs: record.durationMs,
    fingerprint,
    chunkIndex: i,
    kind: part.kind,
    text: part.text,
    vector: vectors[i]
  }));
}

export function hashFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
