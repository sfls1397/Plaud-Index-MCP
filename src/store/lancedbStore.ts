import fs from "node:fs";
import path from "node:path";
import {
  clipSnippet,
  collapseHitsByFile,
  EMPTY_METADATA,
  inDateRange,
  NOTES_TABLE,
  scoreFromLanceDistance,
  type FileRecordView,
  type IndexMetadata,
  type SearchHit,
  type SearchOptions,
  type StoredChunk,
  type VectorStore
} from "./types.js";

const LANCE_CONNECT_OPTIONS = { readConsistencyInterval: 0 };

type LanceQuery = {
  nearestTo?(vector: number[]): { limit(n: number): { toArray(): Promise<Record<string, unknown>[]> } };
  where?(predicate: string): LanceQuery;
  select?(columns: string[]): LanceQuery;
  limit(n: number): { toArray(): Promise<Record<string, unknown>[]> };
  toArray?(): Promise<Record<string, unknown>[]>;
};

type LanceDb = {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, data: Record<string, unknown>[], opts?: { mode?: string }): Promise<LanceTable>;
  dropTable?(name: string): Promise<void>;
};

type LanceTable = {
  add(data: Record<string, unknown>[]): Promise<unknown>;
  delete(predicate: string): Promise<unknown>;
  countRows?(filter?: string): Promise<number>;
  query(): LanceQuery;
  vectorSearch?(vector: number[]): { limit(n: number): { toArray(): Promise<Record<string, unknown>[]> } };
};

/**
 * LanceDB on-disk store. Re-lists tables on every isReady() so a first empty
 * catalog (writer in flight) is not cached forever.
 */
export class LanceVectorStore implements VectorStore {
  readonly indexDir: string;
  private readonly metaFile: string;
  private db: LanceDb | null = null;
  private connectPromise: Promise<LanceDb> | null = null;
  private readonly connectFn: (uri: string, options: unknown) => Promise<LanceDb>;

  constructor(
    indexDir: string,
    connectFn?: (uri: string, options: unknown) => Promise<LanceDb>
  ) {
    this.indexDir = indexDir;
    this.metaFile = path.join(indexDir, "metadata.json");
    this.connectFn = connectFn || defaultConnect;
  }

  async isReady(): Promise<boolean> {
    try {
      let db = await this.connect();
      let names = await db.tableNames();
      if (!names.includes(NOTES_TABLE)) {
        const onDisk = lanceDirExists(this.indexDir, NOTES_TABLE) || this.readMeta().populated;
        if (onDisk) {
          await this.resetConnection();
          db = await this.connect();
          names = await db.tableNames();
        }
      }
      if (!names.includes(NOTES_TABLE)) {
        return false;
      }
      const table = await db.openTable(NOTES_TABLE);
      const rows = await table.query().limit(1).toArray();
      return rows.length > 0;
    } catch {
      return lanceDirExists(this.indexDir, NOTES_TABLE) || this.readMeta().populated;
    }
  }

  async getMetadata(): Promise<IndexMetadata> {
    return this.readMeta();
  }

  async updateMetadata(partial: Partial<IndexMetadata>): Promise<void> {
    const prev = this.readMeta();
    this.writeMeta({ ...prev, ...partial, updatedAt: new Date().toISOString() });
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    const db = await this.connect();
    const names = await db.tableNames();
    const rows = chunks.map(chunkToRow);
    let table: LanceTable;
    if (!names.includes(NOTES_TABLE)) {
      table = await db.createTable(NOTES_TABLE, rows);
    } else {
      table = await db.openTable(NOTES_TABLE);
      const ids = [...new Set(chunks.map((c) => c.fileId))];
      for (const id of ids) {
        await table.delete(`file_id = '${escapeSql(id)}'`);
      }
      await table.add(rows);
    }
    const prev = this.readMeta();
    await this.syncCountsFromTable(table, {
      embedDim: prev.embedDim || chunks[0]?.vector.length || 0
    });
  }

  async deleteFile(fileId: string): Promise<void> {
    const db = await this.connect();
    const names = await db.tableNames();
    if (!names.includes(NOTES_TABLE)) {
      return;
    }
    const table = await db.openTable(NOTES_TABLE);
    await table.delete(`file_id = '${escapeSql(fileId)}'`);
    await this.syncCountsFromTable(table);
  }

  async replaceAll(chunks: StoredChunk[], meta: Partial<IndexMetadata>): Promise<void> {
    const db = await this.connect();
    const names = await db.tableNames();
    if (names.includes(NOTES_TABLE) && db.dropTable) {
      await db.dropTable(NOTES_TABLE);
    }
    if (chunks.length > 0) {
      await db.createTable(NOTES_TABLE, chunks.map(chunkToRow), { mode: "overwrite" });
    }
    this.writeMeta({
      ...EMPTY_METADATA,
      ...meta,
      chunkCount: chunks.length,
      noteCount: new Set(chunks.map((c) => c.fileId)).size,
      populated: chunks.length > 0,
      updatedAt: new Date().toISOString()
    });
  }

  async search(vector: number[], options: SearchOptions = {}): Promise<SearchHit[]> {
    const db = await this.connect();
    const names = await db.tableNames();
    if (!names.includes(NOTES_TABLE)) {
      return [];
    }
    const table = await db.openTable(NOTES_TABLE);
    const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
    const fetch = Math.max(limit * 8, 32);
    let rows: Record<string, unknown>[] = [];
    try {
      if (typeof table.vectorSearch === "function") {
        rows = await table.vectorSearch(vector).limit(fetch).toArray();
      } else {
        const q = table.query();
        if (q.nearestTo) {
          rows = await q.nearestTo(vector).limit(fetch).toArray();
        } else {
          rows = await q.limit(fetch).toArray();
        }
      }
    } catch {
      rows = await table.query().limit(fetch).toArray();
    }
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const createdAt = asString(row.created_at);
      if (!inDateRange(createdAt, options.dateFrom, options.dateTo)) {
        continue;
      }
      hits.push({
        fileId: String(row.file_id || ""),
        title: String(row.title || ""),
        createdAt,
        durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
        score: typeof row._distance === "number" ? scoreFromLanceDistance(row._distance) : Number(row.score || 0),
        snippet: clipSnippet(String(row.text || "")),
        kind: String(row.kind || "transcript")
      });
    }
    return collapseHitsByFile(hits, limit);
  }

  async getFile(fileId: string): Promise<FileRecordView | null> {
    const db = await this.connect();
    const names = await db.tableNames();
    if (!names.includes(NOTES_TABLE)) {
      return null;
    }
    const table = await db.openTable(NOTES_TABLE);
    const rows = await queryTableRows(table, {
      where: `file_id = '${escapeSql(fileId)}'`
    });
    const mine = rows
      .filter((r) => String(r.file_id) === fileId)
      .sort((a, b) => Number(a.chunk_index || 0) - Number(b.chunk_index || 0));
    if (mine.length === 0) {
      return null;
    }
    const first = mine[0];
    return {
      fileId,
      title: String(first.title || ""),
      createdAt: asString(first.created_at),
      durationMs: typeof first.duration_ms === "number" ? first.duration_ms : null,
      fingerprint: String(first.fingerprint || ""),
      chunkCount: mine.length,
      snippets: mine.slice(0, 3).map((r) => clipSnippet(String(r.text || "")))
    };
  }

  async listFingerprints(): Promise<Map<string, string>> {
    const db = await this.connect();
    const names = await db.tableNames();
    const map = new Map<string, string>();
    if (!names.includes(NOTES_TABLE)) {
      return map;
    }
    const table = await db.openTable(NOTES_TABLE);
    const rows = await queryTableRows(table, { columns: ["file_id", "fingerprint"] });
    for (const row of rows) {
      const id = String(row.file_id || "");
      if (id && !map.has(id)) {
        map.set(id, String(row.fingerprint || ""));
      }
    }
    return map;
  }

  async close(): Promise<void> {
    this.db = null;
    this.connectPromise = null;
  }

  private async connect(): Promise<LanceDb> {
    if (this.db) {
      return this.db;
    }
    if (!this.connectPromise) {
      fs.mkdirSync(this.indexDir, { recursive: true });
      this.connectPromise = this.connectFn(this.indexDir, LANCE_CONNECT_OPTIONS).then((db) => {
        this.db = db;
        return db;
      });
    }
    return this.connectPromise;
  }

  private async resetConnection(): Promise<void> {
    this.db = null;
    this.connectPromise = null;
  }

  private readMeta(): IndexMetadata {
    try {
      if (!fs.existsSync(this.metaFile)) {
        return { ...EMPTY_METADATA };
      }
      const parsed = JSON.parse(fs.readFileSync(this.metaFile, "utf8")) as IndexMetadata;
      return { ...EMPTY_METADATA, ...parsed };
    } catch {
      return { ...EMPTY_METADATA };
    }
  }

  private writeMeta(meta: IndexMetadata): void {
    fs.mkdirSync(this.indexDir, { recursive: true });
    const tmp = metaTmp(this.metaFile);
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, this.metaFile);
  }

  private async syncCountsFromTable(
    table: LanceTable,
    extra: Partial<IndexMetadata> = {}
  ): Promise<void> {
    const prev = this.readMeta();
    const rows = await queryTableRows(table, { columns: ["file_id"] });
    const fileIds = new Set(rows.map((r) => String(r.file_id || "")).filter(Boolean));
    this.writeMeta({
      ...prev,
      ...extra,
      chunkCount: rows.length,
      noteCount: fileIds.size,
      populated: rows.length > 0,
      updatedAt: new Date().toISOString(),
      schemaVersion: prev.schemaVersion || 1
    });
  }
}

function chunkToRow(chunk: StoredChunk): Record<string, unknown> {
  return {
    id: chunk.id,
    file_id: chunk.fileId,
    title: chunk.title,
    created_at: chunk.createdAt,
    duration_ms: chunk.durationMs,
    fingerprint: chunk.fingerprint,
    chunk_index: chunk.chunkIndex,
    kind: chunk.kind,
    text: chunk.text,
    vector: chunk.vector
  };
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

async function queryTableRows(
  table: LanceTable,
  options: { where?: string; limit?: number; columns?: string[] } = {}
): Promise<Record<string, unknown>[]> {
  let q: LanceQuery = table.query();
  if (options.where) {
    if (typeof q.where !== "function") {
      throw new Error("LanceDB query.where is required for file_id lookups");
    }
    q = q.where(options.where);
  }
  if (options.columns && typeof q.select === "function") {
    q = q.select(options.columns);
  }
  if (options.limit != null) {
    return q.limit(options.limit).toArray();
  }
  if (typeof q.toArray === "function") {
    return q.toArray();
  }
  return q.limit(1_000_000).toArray();
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function lanceDirExists(indexDir: string, name: string): boolean {
  if (name !== NOTES_TABLE) {
    return false;
  }
  return fs.existsSync(path.join(indexDir, `${name}.lance`));
}

function metaTmp(metaFile: string): string {
  return `${metaFile}.${process.pid}.tmp`;
}

async function defaultConnect(uri: string, options: unknown): Promise<LanceDb> {
  const lancedb = await import("@lancedb/lancedb");
  return lancedb.connect(uri, options as never) as unknown as LanceDb;
}
