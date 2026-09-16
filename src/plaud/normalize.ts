import type { PlaudFileSummary, PlaudNoteTab, PlaudTranscriptPage, PlaudUtterance } from "./types.js";

export function assertFileId(fileId: string): string {
  const id = typeof fileId === "string" ? fileId.trim() : "";
  if (!id || id.length > 128 || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error("Invalid Plaud file id");
  }
  return id;
}

export function extractObject(payload: unknown): Record<string, unknown> | null {
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

export function extractFileList(payload: unknown): Record<string, unknown>[] {
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

export function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function normalizeSummary(raw: Record<string, unknown>): PlaudFileSummary {
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

export function notesFromFilePayload(payload: unknown): PlaudNoteTab[] {
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
        asString(rec.data_content) ||
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
        kind: asString(rec.kind) || asString(rec.data_type) || asString(rec.content_type) || asString(rec.type) || undefined,
        markdown
      });
    }
  }
  if (typeof obj.markdown === "string" && obj.markdown.trim()) {
    notes.push({ markdown: obj.markdown, kind: "note" });
  }
  return notes;
}

export function utterancesFromUnknown(list: unknown): PlaudUtterance[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const utterances: PlaudUtterance[] = [];
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
  return utterances;
}

export function transcriptFromFilePayload(payload: unknown): PlaudTranscriptPage {
  const obj = extractObject(payload) || (payload as Record<string, unknown> | null);
  if (!obj) {
    return { utterances: [] };
  }
  const lists = [obj.source_list, obj.utterances, obj.transcript, obj.segments, obj.data];
  for (const list of lists) {
    const utterances = utterancesFromUnknown(list);
    if (utterances.length > 0) {
      return {
        utterances,
        nextCursor: asString(obj.next_cursor) || asString(obj.nextCursor)
      };
    }
  }
  const text = asString(obj.transcript_text) || asString(obj.text);
  return {
    utterances: text ? [{ text }] : [],
    nextCursor: asString(obj.next_cursor) || asString(obj.nextCursor)
  };
}
