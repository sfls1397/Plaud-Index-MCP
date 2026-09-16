import fs from "node:fs";
import path from "node:path";
import {
  clipSnippet,
  collapseHitsByFile,
  cosine,
  EMPTY_METADATA,
  inDateRange,
  type FileRecordView,
  type IndexMetadata,
  type SearchHit,
  type SearchOptions,
  type StoredChunk,
  type VectorStore
} from "./types.js";

interface FileStoreDisk {
  metadata: IndexMetadata;
  chunks: StoredChunk[];
}

/**
 * On-disk cosine vector index under vector-index/. Used by tests always,
 * and as a fallback when LanceDB native bindings are unavailable.
 */
export class FileVectorStore implements VectorStore {
  readonly indexDir: string;
  private readonly dataFile: string;
  private readonly metaFile: string;

  constructor(indexDir: string) {
    this.indexDir = indexDir;
    this.dataFile = path.join(indexDir, "chunks.json");
    this.metaFile = path.join(indexDir, "metadata.json");
  }

  async isReady(): Promise<boolean> {
    const disk = this.readDisk();
    return disk.chunks.length > 0;
  }

  async getMetadata(): Promise<IndexMetadata> {
    return this.readDisk().metadata;
  }

  async updateMetadata(partial: Partial<IndexMetadata>): Promise<void> {
    const disk = this.readDisk();
    disk.metadata = { ...disk.metadata, ...partial };
    this.writeDisk(disk);
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    const disk = this.readDisk();
    const ids = new Set(chunks.map((c) => c.fileId));
    const kept = disk.chunks.filter((c) => !ids.has(c.fileId));
    disk.chunks = [...kept, ...chunks];
    this.writeDisk(disk);
  }

  async deleteFile(fileId: string): Promise<void> {
    const disk = this.readDisk();
    disk.chunks = disk.chunks.filter((c) => c.fileId !== fileId);
    this.writeDisk(disk);
  }

  async replaceAll(chunks: StoredChunk[], meta: Partial<IndexMetadata>): Promise<void> {
    const disk: FileStoreDisk = {
      metadata: {
        ...EMPTY_METADATA,
        ...meta,
        chunkCount: chunks.length,
        noteCount: new Set(chunks.map((c) => c.fileId)).size,
        populated: chunks.length > 0,
        updatedAt: new Date().toISOString()
      },
      chunks
    };
    this.writeDisk(disk);
  }

  async search(vector: number[], options: SearchOptions = {}): Promise<SearchHit[]> {
    const disk = this.readDisk();
    const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
    const scored: SearchHit[] = [];
    for (const chunk of disk.chunks) {
      if (!inDateRange(chunk.createdAt, options.dateFrom, options.dateTo)) {
        continue;
      }
      scored.push({
        fileId: chunk.fileId,
        title: chunk.title,
        createdAt: chunk.createdAt,
        durationMs: chunk.durationMs,
        score: cosine(vector, chunk.vector),
        snippet: clipSnippet(chunk.text),
        kind: chunk.kind
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return collapseHitsByFile(scored.slice(0, Math.max(limit * 4, limit)), limit);
  }

  async getFile(fileId: string): Promise<FileRecordView | null> {
    const disk = this.readDisk();
    const chunks = disk.chunks
      .filter((c) => c.fileId === fileId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    if (chunks.length === 0) {
      return null;
    }
    const first = chunks[0];
    return {
      fileId: first.fileId,
      title: first.title,
      createdAt: first.createdAt,
      durationMs: first.durationMs,
      fingerprint: first.fingerprint,
      chunkCount: chunks.length,
      snippets: chunks.slice(0, 3).map((c) => clipSnippet(c.text))
    };
  }

  async listFingerprints(): Promise<Map<string, string>> {
    const disk = this.readDisk();
    const map = new Map<string, string>();
    for (const chunk of disk.chunks) {
      if (!map.has(chunk.fileId)) {
        map.set(chunk.fileId, chunk.fingerprint);
      }
    }
    return map;
  }

  async close(): Promise<void> {
    // no-op
  }

  private readDisk(): FileStoreDisk {
    try {
      if (!fs.existsSync(this.dataFile)) {
        return { metadata: { ...EMPTY_METADATA }, chunks: [] };
      }
      const parsed = JSON.parse(fs.readFileSync(this.dataFile, "utf8")) as FileStoreDisk;
      if (!parsed || !Array.isArray(parsed.chunks)) {
        return { metadata: { ...EMPTY_METADATA }, chunks: [] };
      }
      return parsed;
    } catch {
      return { metadata: { ...EMPTY_METADATA }, chunks: [] };
    }
  }

  private writeDisk(disk: FileStoreDisk): void {
    fs.mkdirSync(this.indexDir, { recursive: true });
    disk.metadata = {
      ...EMPTY_METADATA,
      ...disk.metadata,
      chunkCount: disk.chunks.length,
      noteCount: new Set(disk.chunks.map((c) => c.fileId)).size,
      populated: disk.chunks.length > 0,
      updatedAt: new Date().toISOString()
    };
    const tmp = `${this.dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(disk));
    fs.renameSync(tmp, this.dataFile);
    const metaTmp = `${this.metaFile}.${process.pid}.tmp`;
    fs.writeFileSync(metaTmp, JSON.stringify(disk.metadata, null, 2));
    fs.renameSync(metaTmp, this.metaFile);
  }
}
