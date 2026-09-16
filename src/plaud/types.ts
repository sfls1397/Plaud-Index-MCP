/**
 * Plaud recording (file) + notes/transcript shapes used by the indexer.
 * "file_id" is Plaud's recording id — the same id remote Plaud MCP tools
 * (`get_file`, `get_note`, `get_transcript`) accept.
 */

export interface PlaudFileSummary {
  id: string;
  name: string;
  createdAt: string | null;
  startAt: string | null;
  durationMs: number | null;
  updatedAt: string | null;
}

export interface PlaudNoteTab {
  id?: string;
  title?: string;
  kind?: string;
  markdown: string;
}

export interface PlaudUtterance {
  speaker?: string;
  startMs?: number;
  endMs?: number;
  text: string;
}

export interface PlaudTranscriptPage {
  utterances: PlaudUtterance[];
  nextCursor?: string | null;
}

export interface PlaudFileRecord extends PlaudFileSummary {
  notes: PlaudNoteTab[];
  transcriptText: string;
  utterances: PlaudUtterance[];
}

export interface ListFilesOptions {
  page?: number;
  pageSize?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface PlaudClient {
  listFiles(options?: ListFilesOptions): Promise<PlaudFileSummary[]>;
  getFile(fileId: string): Promise<PlaudFileSummary>;
  getNotes(fileId: string): Promise<PlaudNoteTab[]>;
  getTranscript(fileId: string): Promise<PlaudTranscriptPage>;
  loadRecord(fileId: string): Promise<PlaudFileRecord>;
}

export function fingerprintRecord(record: PlaudFileRecord): string {
  const notes = record.notes.map((n) => `${n.kind || ""}:${n.title || ""}:${n.markdown}`).join("\n");
  return [
    record.id,
    record.name,
    record.updatedAt || record.createdAt || "",
    String(record.durationMs ?? ""),
    record.transcriptText,
    notes
  ].join("\u001f");
}
