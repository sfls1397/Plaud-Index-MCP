export const NOTES_TABLE = "notes";

export interface IndexMetadata {
  embedModel: string;
  embedDim: number;
  noteCount: number;
  chunkCount: number;
  updatedAt: string | null;
  populated: boolean;
  schemaVersion: number;
}

export interface StoredChunk {
  id: string;
  fileId: string;
  title: string;
  createdAt: string | null;
  durationMs: number | null;
  fingerprint: string;
  chunkIndex: number;
  kind: "transcript" | "note" | "title";
  text: string;
  vector: number[];
}

export interface SearchHit {
  fileId: string;
  title: string;
  createdAt: string | null;
  durationMs: number | null;
  score: number;
  snippet: string;
  kind: string;
}

export interface FileRecordView {
  fileId: string;
  title: string;
  createdAt: string | null;
  durationMs: number | null;
  fingerprint: string;
  chunkCount: number;
  snippets: string[];
}

export interface SearchOptions {
  limit?: number;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface VectorStore {
  readonly indexDir: string;
  isReady(): Promise<boolean>;
  getMetadata(): Promise<IndexMetadata>;
  updateMetadata(partial: Partial<IndexMetadata>): Promise<void>;
  upsertChunks(chunks: StoredChunk[]): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
  replaceAll(chunks: StoredChunk[], meta: Partial<IndexMetadata>): Promise<void>;
  search(vector: number[], options?: SearchOptions): Promise<SearchHit[]>;
  getFile(fileId: string): Promise<FileRecordView | null>;
  listFingerprints(): Promise<Map<string, string>>;
  close(): Promise<void>;
}

export const EMPTY_METADATA: IndexMetadata = {
  embedModel: "",
  embedDim: 0,
  noteCount: 0,
  chunkCount: 0,
  updatedAt: null,
  populated: false,
  schemaVersion: 1
};

export const SNIPPET_MAX_CHARS = 280;

export function clipSnippet(text: string, max = SNIPPET_MAX_CHARS): string {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max - 1).trim()}…`;
}

export function parseDayStart(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function parseDayEnd(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const ms = Date.parse(`${date}T23:59:59.999Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function inDateRange(
  createdAt: string | null,
  dateFrom?: string | null,
  dateTo?: string | null
): boolean {
  if (!dateFrom && !dateTo) {
    return true;
  }
  if (!createdAt) {
    return false;
  }
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) {
    return false;
  }
  if (dateFrom) {
    const from = parseDayStart(dateFrom);
    if (from !== null && ts < from) {
      return false;
    }
  }
  if (dateTo) {
    const to = parseDayEnd(dateTo);
    if (to !== null && ts > to) {
      return false;
    }
  }
  return true;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) {
    return 0;
  }
  return dot / denom;
}

export function collapseHitsByFile(hits: SearchHit[], limit: number): SearchHit[] {
  const best = new Map<string, SearchHit>();
  for (const hit of hits) {
    const existing = best.get(hit.fileId);
    if (!existing || hit.score > existing.score) {
      best.set(hit.fileId, hit);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
