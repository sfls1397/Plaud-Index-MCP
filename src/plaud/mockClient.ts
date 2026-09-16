import type {
  ListFilesOptions,
  PlaudClient,
  PlaudFileRecord,
  PlaudFileSummary,
  PlaudNoteTab,
  PlaudTranscriptPage
} from "./types.js";

const DEFAULT_FILES: PlaudFileRecord[] = [
  {
    id: "file-standup-001",
    name: "Tuesday standup",
    createdAt: "2026-09-15T15:00:00.000Z",
    startAt: "2026-09-15T15:00:00.000Z",
    durationMs: 18 * 60 * 1000,
    updatedAt: "2026-09-15T15:20:00.000Z",
    notes: [
      {
        kind: "auto_sum_note",
        title: "Summary",
        markdown: "Ship Plaud index MCP v1. Indexer on Mini. Query MCP returns file ids."
      }
    ],
    transcriptText:
      "Alice: Let's ship the Plaud indexer this week.\nBob: Search should return Plaud file ids so Grok can fetch transcripts from Plaud MCP.",
    utterances: [
      { speaker: "Alice", text: "Let's ship the Plaud indexer this week." },
      {
        speaker: "Bob",
        text: "Search should return Plaud file ids so Grok can fetch transcripts from Plaud MCP."
      }
    ]
  },
  {
    id: "file-design-002",
    name: "Design review",
    createdAt: "2026-09-14T18:30:00.000Z",
    startAt: "2026-09-14T18:30:00.000Z",
    durationMs: 42 * 60 * 1000,
    updatedAt: "2026-09-14T19:15:00.000Z",
    notes: [
      {
        kind: "auto_sum_note",
        title: "Summary",
        markdown: "Local embeddings with Xenova MiniLM. Model bump triggers full re-index."
      }
    ],
    transcriptText:
      "Chris: Use Xenova all-MiniLM-L6-v2 locally.\nDana: Store the model id in index metadata so a bump reindexes.",
    utterances: [
      { speaker: "Chris", text: "Use Xenova all-MiniLM-L6-v2 locally." },
      { speaker: "Dana", text: "Store the model id in index metadata so a bump reindexes." }
    ]
  }
];

/**
 * In-memory Plaud client for tests. No network, no secrets.
 */
export class MockPlaudClient implements PlaudClient {
  readonly files: Map<string, PlaudFileRecord>;

  constructor(records: PlaudFileRecord[] = DEFAULT_FILES) {
    this.files = new Map(records.map((r) => [r.id, structuredClone(recordCopy(r))]));
  }

  async listFiles(options: ListFilesOptions = {}): Promise<PlaudFileSummary[]> {
    let rows = [...this.files.values()].map(toSummary);
    if (options.dateFrom) {
      const from = Date.parse(options.dateFrom);
      rows = rows.filter((r) => (r.createdAt ? Date.parse(r.createdAt) >= from : true));
    }
    if (options.dateTo) {
      const to = Date.parse(`${options.dateTo}T23:59:59.999Z`);
      rows = rows.filter((r) => (r.createdAt ? Date.parse(r.createdAt) <= to : true));
    }
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 50;
    const start = (page - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }

  async getFile(fileId: string): Promise<PlaudFileSummary> {
    return toSummary(this.require(fileId));
  }

  async getNotes(fileId: string): Promise<PlaudNoteTab[]> {
    return this.require(fileId).notes;
  }

  async getTranscript(fileId: string): Promise<PlaudTranscriptPage> {
    const rec = this.require(fileId);
    return { utterances: rec.utterances };
  }

  async loadRecord(fileId: string): Promise<PlaudFileRecord> {
    return structuredClone(this.require(fileId));
  }

  upsert(record: PlaudFileRecord): void {
    this.files.set(record.id, recordCopy(record));
  }

  private require(fileId: string): PlaudFileRecord {
    const rec = this.files.get(fileId);
    if (!rec) {
      throw new Error(`Unknown mock Plaud file: ${fileId}`);
    }
    return rec;
  }
}

function toSummary(record: PlaudFileRecord): PlaudFileSummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    startAt: record.startAt,
    durationMs: record.durationMs,
    updatedAt: record.updatedAt
  };
}

function recordCopy(record: PlaudFileRecord): PlaudFileRecord {
  return {
    ...record,
    notes: record.notes.map((n) => ({ ...n })),
    utterances: record.utterances.map((u) => ({ ...u }))
  };
}
