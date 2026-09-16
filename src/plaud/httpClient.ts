import type {
  ListFilesOptions,
  PlaudClient,
  PlaudFileRecord,
  PlaudFileSummary,
  PlaudNoteTab,
  PlaudTranscriptPage
} from "./types.js";
import { redactSecrets } from "../sanitize.js";
import {
  assertFileId,
  extractFileList,
  extractObject,
  notesFromFilePayload,
  normalizeSummary,
  transcriptFromFilePayload
} from "./normalize.js";
import { DEFAULT_WEB_API_BASE } from "../auth/constants.js";

const DEFAULT_API_BASE = DEFAULT_WEB_API_BASE;

export interface HttpPlaudClientOptions {
  env?: NodeJS.ProcessEnv;
  token?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * HTTP Plaud client for the **optional** `PLAUD_API_TOKEN` Bearer override.
 * The shareable path is consumer MCP OAuth (`McpPlaudClient` + `plaud-index-mcp login`).
 *
 * Documented request shape (override wiring):
 * - `PLAUD_API_TOKEN` — Bearer token from Keychain/env (not Grok OAuth, not the happy path)
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
      throw new Error(
        "PLAUD_API_TOKEN is not set. Prefer `plaud-index-mcp login`. Bearer override is optional only."
      );
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

