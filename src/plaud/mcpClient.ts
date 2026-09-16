import type {
  ListFilesOptions,
  PlaudClient,
  PlaudFileRecord,
  PlaudFileSummary,
  PlaudNoteTab,
  PlaudTranscriptPage,
  PlaudUtterance
} from "./types.js";
import {
  asString,
  assertFileId,
  extractFileList,
  extractObject,
  notesFromFilePayload,
  normalizeSummary,
  utterancesFromUnknown
} from "./normalize.js";
import { redactSecrets } from "../sanitize.js";
import { AuthExpiredError, isAuthExpiredError } from "../auth/errors.js";
import { RELLOGIN_MESSAGE } from "../auth/constants.js";
import type { PlaudAuthSession } from "../auth/session.js";

const DEFAULT_TRANSCRIPT_BLOCK = "transaction";

export interface McpPlaudClientOptions {
  session: PlaudAuthSession;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  fetchBlockText?: (url: string) => Promise<string>;
}

/**
 * Plaud data plane used by `@plaud-ai/mcp` tools (`list_files`, `get_file`,
 * `get_note`, `get_transcript`): `https://platform.plaud.ai/developer/api`
 * with the consumer MCP OAuth access token.
 */
export class McpPlaudClient implements PlaudClient {
  private readonly session: PlaudAuthSession;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fetchBlockText: (url: string) => Promise<string>;

  constructor(options: McpPlaudClientOptions) {
    this.session = options.session;
    this.baseUrl = (options.baseUrl || options.session.endpoints.apiBase).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl || fetch;
    this.fetchBlockText = options.fetchBlockText || ((url) => fetchHttpsText(url, this.fetchImpl));
  }

  async listFiles(options: ListFilesOptions = {}): Promise<PlaudFileSummary[]> {
    const page = options.page ?? 1;
    const pageSize = Math.max(options.pageSize ?? 50, 10);
    const payload = await this.requestJson(`/open/third-party/files/?page=${page}&page_size=${pageSize}`);
    return extractFileList(payload).map(normalizeSummary);
  }

  async getFile(fileId: string): Promise<PlaudFileSummary> {
    const record = await this.getFilePayload(fileId);
    return normalizeSummary(record);
  }

  async getNotes(fileId: string): Promise<PlaudNoteTab[]> {
    const record = await this.getFilePayload(fileId);
    const resolved = await this.resolveNoteBlocks(record);
    const fromResolved = notesFromFilePayload({ ...record, note_list: resolved });
    if (fromResolved.length > 0) {
      return fromResolved;
    }
    return notesFromFilePayload(record);
  }

  async getTranscript(fileId: string): Promise<PlaudTranscriptPage> {
    const record = await this.getFilePayload(fileId);
    const sourceList = Array.isArray(record.source_list) ? record.source_list : [];
    const selected =
      sourceList.find((item) => item && typeof item === "object" && (item as { data_type?: unknown }).data_type === DEFAULT_TRANSCRIPT_BLOCK) ||
      sourceList[0];
    if (!selected || typeof selected !== "object") {
      return { utterances: [] };
    }
    const content = await this.loadBlockContent(selected as Record<string, unknown>);
    if (!content) {
      return { utterances: [] };
    }
    try {
      const parsed = JSON.parse(content) as unknown;
      const utterances = utterancesFromUnknown(parsed);
      if (utterances.length > 0) {
        return { utterances };
      }
    } catch {
      /* fall through to raw text */
    }
    return { utterances: content.trim() ? [{ text: content }] : [] };
  }

  async loadRecord(fileId: string): Promise<PlaudFileRecord> {
    const summary = await this.getFile(fileId);
    const [notes, transcript] = await Promise.all([this.getNotes(fileId), this.getTranscript(fileId)]);
    const transcriptText = transcript.utterances
      .map((u: PlaudUtterance) => (u.speaker ? `${u.speaker}: ${u.text}` : u.text))
      .join("\n")
      .trim();
    return {
      ...summary,
      notes,
      transcriptText,
      utterances: transcript.utterances
    };
  }

  private async getFilePayload(fileId: string): Promise<Record<string, unknown>> {
    const id = assertFileId(fileId);
    const payload = await this.requestJson(`/open/third-party/files/${encodeURIComponent(id)}`);
    const record = extractObject(payload);
    if (!record) {
      throw new Error("Plaud file not found");
    }
    return record;
  }

  private async resolveNoteBlocks(record: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const list = Array.isArray(record.note_list) ? record.note_list : [];
    const out: Record<string, unknown>[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const rec = { ...(item as Record<string, unknown>) };
      if (!(typeof rec.data_content === "string" && rec.data_content.length > 0) && typeof rec.data_link === "string") {
        try {
          rec.data_content = await this.fetchBlockText(rec.data_link);
        } catch {
          /* leave empty; notesFromFilePayload will skip */
        }
      }
      out.push(rec);
    }
    return out;
  }

  private async loadBlockContent(block: Record<string, unknown>): Promise<string> {
    const inline = asString(block.data_content);
    if (inline) {
      return inline;
    }
    const link = asString(block.data_link);
    if (!link) {
      return "";
    }
    return this.fetchBlockText(link);
  }

  private async requestJson(pathname: string, retried = false): Promise<unknown> {
    const token = await this.session.getAccessToken();
    if (!token) {
      throw new AuthExpiredError();
    }
    const url = `${this.baseUrl}${pathname}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });
    if (response.status === 401 && !retried) {
      try {
        await this.session.refresh();
      } catch (err) {
        if (isAuthExpiredError(err)) {
          throw err;
        }
        throw new AuthExpiredError();
      }
      return this.requestJson(pathname, true);
    }
    if (response.status === 401) {
      throw new AuthExpiredError();
    }
    if (!response.ok) {
      throw new Error(redactSecrets(`Plaud MCP API ${response.status} for ${pathname}`));
    }
    return response.json();
  }
}

const MAX_BLOCK_BYTES = 20 * 1024 * 1024;

export async function fetchHttpsText(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!URL.canParse(rawUrl)) {
    throw new Error("Invalid block URL");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("Block URL must be https");
  }
  if (url.username || url.password) {
    throw new Error("Block URL must not include userinfo");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: ctrl.signal });
    if (!response.ok) {
      throw new Error(`Block fetch HTTP ${response.status}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > MAX_BLOCK_BYTES) {
      throw new Error("Block fetch too large");
    }
    return buf.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

export function mcpAuthMissingMessage(): string {
  return RELLOGIN_MESSAGE;
}
