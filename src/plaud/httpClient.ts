import type {
  ListFilesOptions,
  PlaudClient,
  PlaudFileRecord,
  PlaudFileSummary,
  PlaudNoteTab,
  PlaudTranscriptPage,
  PlaudUtterance
} from "./types.js";
import { redactSecrets } from "../sanitize.js";

const DEFAULT_API_BASE = "https://api.plaud.ai";

export interface HttpPlaudClientOptions {
  env?: NodeJS.ProcessEnv;
  token?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * HTTP Plaud client. Auth: `Authorization: Bearer ${PLAUD_API_TOKEN}`.
 *
 * Documented request shape (indexer wiring):
 * - `PLAUD_API_TOKEN` — Bearer token from Keychain/env (not Grok OAuth)
 * - `PLAUD_API_BASE` — default `https://api.plaud.ai`
 *
 * Endpoints tried (first successful JSON wins):
 * - List: `GET /file/simple/web?page=&page_size=` then `GET /files`
 * - File: `GET /file/detail/{id}` then `GET /files/{id}`
 * - Transcript: file `content_list` / `source_list`, else `GET /files/{id}/transcript`
 * - Notes: file `note_list` / `content_list`, else `GET /files/{id}/note`
 *
 * Response fields are normalized to Plaud MCP-style ids (`id`, `name`,
 * `created_at`) so Grok can pass `file_id` to remote Plaud MCP.
 */
export class HttpPlaudClient implements PlaudClient {
  private readonly token: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpPlaudClientOptions = {}) {
    const env = options.env || process.env;
    this.token = options.token ?? (typeof env.PLAUD_API_TOKEN === "string" ? env.PLAUD_API_TOKEN.trim() : null);
    this.baseUrl = (options.baseUrl || env.PLAUD_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async listFiles(options: ListFilesOptions = {}): Promise<PlaudFileSummary[]> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 50;
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    if (options.dateFrom) params.set("date_from", options.dateFrom);
    if (options.dateTo) params.set("date_to", options.dateTo);

    const payloads = await this.getFirstJson([
      `/file/simple/web?${params.toString()}`,
      `/files?${params.toString()}`
    ]);
    return extractFileList(payloads).map(normalizeSummary);
  }

  async getFile(fileId: string): Promise<PlaudFileSummary> {
    const id = assertFileId(fileId);
    const payload = await this.getFirstJson([`/file/detail/${encodeURIComponent(id)}`, `/files/${encodeURIComponent(id)}`]);
    const record = extractObject(payload);
    if (!record) {
      throw new Error("Plaud file not found");
    }
    return normalizeSummary(record);
  }

  async getNotes(fileId: string): Promise<PlaudNoteTab[]> {
    const id = assertFileId(fileId);
    const filePayload = await this.getFirstJson([
      `/file/detail/${encodeURIComponent(id)}`,
      `/files/${encodeURIComponent(id)}`
    ]);
    const fromFile = notesFromFilePayload(filePayload);
    if (fromFile.length > 0) {
      return fromFile;
    }
    const notePayload = await this.getFirstJson([
      `/files/${encodeURIComponent(id)}/note`,
      `/files/${encodeURIComponent(id)}/notes`
    ]);
    return notesFromFilePayload(notePayload);
  }

  async getTranscript(fileId: string): Promise<PlaudTranscriptPage> {
    const id = assertFileId(fileId);
    const filePayload = await this.getFirstJson([
      `/file/detail/${encodeURIComponent(id)}`,
      `/files/${encodeURIComponent(id)}`
    ]);
    const fromFile = transcriptFromFilePayload(filePayload);
    if (fromFile.utterances.length > 0 || fromFile.nextCursor) {
      return fromFile;
    }
    const transcriptPayload = await this.getFirstJson([`/files/${encodeURIComponent(id)}/transcript`]);
    return transcriptFromFilePayload(transcriptPayload);
  }

  async loadRecord(fileId: string): Promise<PlaudFileRecord> {
    const summary = await this.getFile(fileId);
    const [notes, transcript] = await Promise.all([this.getNotes(fileId), this.getTranscript(fileId)]);
    const transcriptText = transcript.utterances
      .map((u) => (u.speaker ? `${u.speaker}: ${u.text}` : u.text))
      .join("\n")
      .trim();
    return {
      ...summary,
      notes,
      transcriptText,
      utterances: transcript.utterances
    };
  }

  private async getFirstJson(paths: string[]): Promise<unknown> {
    if (!this.token) {
      throw new Error("PLAUD_API_TOKEN is not set. Set it from Keychain or env. Do not use Grok OAuth.");
    }
    let lastError: Error | null = null;
    for (const p of paths) {
      try {
        return await this.getJson(p);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError || new Error("Plaud API request failed");
  }

  private async getJson(pathname: string): Promise<unknown> {
    const url = pathname.startsWith("http") ? pathname : `${this.baseUrl}${pathname}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(redactSecrets(`Plaud API ${response.status} for ${pathname}`));
    }
    return response.json();
  }
}

function assertFileId(fileId: string): string {
  const id = typeof fileId === "string" ? fileId.trim() : "";
  if (!id || id.length > 128 || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error("Invalid Plaud file id");
  }
  return id;
}

function extractObject(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    const data = obj.data as Record<string, unknown>;
    if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
      return data.data as Record<string, unknown>;
    }
    return data;
  }
  return obj;
}

function extractFileList(payload: unknown): Record<string, unknown>[] {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  }
  if (typeof payload !== "object") {
    return [];
  }
  const obj = payload as Record<string, unknown>;
  const candidates = [
    obj.data_list,
    obj.files,
    obj.items,
    obj.data,
    (obj.data as Record<string, unknown> | undefined)?.data_list,
    (obj.data as Record<string, unknown> | undefined)?.files,
    (obj.data as Record<string, unknown> | undefined)?.data
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
    }
  }
  return [];
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function normalizeSummary(raw: Record<string, unknown>): PlaudFileSummary {
  const id = asString(raw.id) || asString(raw.file_id) || asString(raw.fileId);
  if (!id) {
    throw new Error("Plaud file payload missing id");
  }
  return {
    id,
    name: asString(raw.name) || asString(raw.filename) || asString(raw.title) || "Untitled recording",
    createdAt: asString(raw.created_at) || asString(raw.createdAt) || asString(raw.start_at) || asString(raw.startAt),
    startAt: asString(raw.start_at) || asString(raw.startAt),
    durationMs: asNumber(raw.duration) ?? asNumber(raw.duration_ms) ?? asNumber(raw.durationMs),
    updatedAt: asString(raw.updated_at) || asString(raw.updatedAt) || asString(raw.edit_time)
  };
}

function notesFromFilePayload(payload: unknown): PlaudNoteTab[] {
  const obj = extractObject(payload) || (payload as Record<string, unknown> | null);
  if (!obj) {
    return [];
  }
  const lists = [obj.note_list, obj.notes, obj.tabs];
  const notes: PlaudNoteTab[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const markdown =
        asString(rec.markdown) ||
        asString(rec.content) ||
        asString(rec.text) ||
        asString(rec.note) ||
        "";
      if (!markdown) {
        continue;
      }
      notes.push({
        id: asString(rec.id) || undefined,
        title: asString(rec.title) || asString(rec.name) || undefined,
        kind: asString(rec.kind) || asString(rec.content_type) || asString(rec.type) || undefined,
        markdown
      });
    }
  }
  if (typeof obj.markdown === "string" && obj.markdown.trim()) {
    notes.push({ markdown: obj.markdown, kind: "note" });
  }
  return notes;
}

function transcriptFromFilePayload(payload: unknown): PlaudTranscriptPage {
  const obj = extractObject(payload) || (payload as Record<string, unknown> | null);
  if (!obj) {
    return { utterances: [] };
  }
  const lists = [obj.source_list, obj.utterances, obj.transcript, obj.segments, obj.data];
  const utterances: PlaudUtterance[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (typeof item === "string" && item.trim()) {
        utterances.push({ text: item });
        continue;
      }
      if (!item || typeof item !== "object") {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const text = asString(rec.text) || asString(rec.content) || asString(rec.sentence) || "";
      if (!text) {
        continue;
      }
      utterances.push({
        speaker: asString(rec.speaker) || asString(rec.speaker_name) || undefined,
        startMs: asNumber(rec.start) ?? asNumber(rec.start_ms) ?? asNumber(rec.startMs) ?? undefined,
        endMs: asNumber(rec.end) ?? asNumber(rec.end_ms) ?? asNumber(rec.endMs) ?? undefined,
        text
      });
    }
    if (utterances.length > 0) {
      break;
    }
  }
  if (utterances.length === 0) {
    const text = asString(obj.transcript_text) || asString(obj.text);
    if (text) {
      utterances.push({ text });
    }
  }
  return {
    utterances,
    nextCursor: asString(obj.next_cursor) || asString(obj.nextCursor)
  };
}
