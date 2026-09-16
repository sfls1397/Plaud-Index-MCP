export const DEFAULT_CHUNK_CHARS = 800;
export const DEFAULT_CHUNK_OVERLAP = 120;

export interface TextChunk {
  index: number;
  text: string;
}

/**
 * Split long transcripts/notes into overlapping character windows.
 * Prefers paragraph then sentence boundaries so embeddings stay coherent.
 */
export function chunkText(
  text: string,
  options: { size?: number; overlap?: number } = {}
): TextChunk[] {
  const size = options.size ?? DEFAULT_CHUNK_CHARS;
  const overlap = options.overlap ?? DEFAULT_CHUNK_OVERLAP;
  const cleaned = (text || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) {
    return [];
  }
  if (cleaned.length <= size) {
    return [{ index: 0, text: cleaned }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < cleaned.length) {
    let end = Math.min(cleaned.length, start + size);
    if (end < cleaned.length) {
      const window = cleaned.slice(start, end);
      const para = window.lastIndexOf("\n\n");
      const sentence = window.lastIndexOf(". ");
      const breakAt = para >= size * 0.4 ? para : sentence >= size * 0.4 ? sentence + 1 : -1;
      if (breakAt > 0) {
        end = start + breakAt + 1;
      }
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece) {
      chunks.push({ index, text: piece });
      index += 1;
    }
    if (end >= cleaned.length) {
      break;
    }
    start = Math.max(0, end - overlap);
    if (start >= end) {
      start = end;
    }
  }
  return chunks;
}

export function buildIndexText(title: string, body: string): string {
  const heading = title.trim();
  const content = body.trim();
  if (!heading) {
    return content;
  }
  if (!content) {
    return heading;
  }
  return `${heading}\n\n${content}`;
}
