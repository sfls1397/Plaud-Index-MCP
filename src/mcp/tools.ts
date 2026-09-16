import { indexQueryGate, INDEX_UNAVAILABLE_MESSAGE } from "../indexGate.js";
import type { Embedder } from "../embed.js";
import type { VectorStore } from "../store/types.js";

export const PLAUD_FETCH_HINT =
  "Use remote Plaud MCP get_file / get_note / get_transcript with this file_id for full text. This index MCP returns ids, not full transcript dumps.";

export interface QuerySession {
  sessionIndexComplete: boolean;
  ownsIndexLock: boolean;
  isFirstEverRun: boolean;
}

export async function requireIndex(
  store: VectorStore,
  session: QuerySession
): Promise<string | null> {
  const ready = await store.isReady();
  const gate = indexQueryGate({
    sessionIndexComplete: session.sessionIndexComplete,
    ownsIndexLock: session.ownsIndexLock,
    indexReady: ready,
    isFirstEverRun: session.isFirstEverRun
  });
  return gate.ok ? null : gate.message || INDEX_UNAVAILABLE_MESSAGE;
}

export function formatSearchResults(hits: {
  fileId: string;
  title: string;
  createdAt: string | null;
  durationMs: number | null;
  score: number;
  snippet: string;
}[]): string {
  if (hits.length === 0) {
    return JSON.stringify(
      {
        results: [],
        hint: "No matching Plaud files. Ids only — do not invent recordings."
      },
      null,
      2
    );
  }
  return JSON.stringify(
    {
      results: hits.map((h) => ({
        file_id: h.fileId,
        title: h.title,
        created_at: h.createdAt,
        duration_ms: h.durationMs,
        score: Number(h.score.toFixed(4)),
        snippet: h.snippet,
        fetch: PLAUD_FETCH_HINT
      }))
    },
    null,
    2
  );
}

export function formatGetResult(view: {
  fileId: string;
  title: string;
  createdAt: string | null;
  durationMs: number | null;
  chunkCount: number;
  snippets: string[];
} | null): string {
  if (!view) {
    return JSON.stringify(
      {
        error: "Unknown Plaud file_id in the local index.",
        hint: PLAUD_FETCH_HINT
      },
      null,
      2
    );
  }
  return JSON.stringify(
    {
      file_id: view.fileId,
      title: view.title,
      created_at: view.createdAt,
      duration_ms: view.durationMs,
      chunk_count: view.chunkCount,
      snippets: view.snippets,
      fetch: PLAUD_FETCH_HINT
    },
    null,
    2
  );
}

export async function runPlaudSearch(
  store: VectorStore,
  embedder: Embedder,
  session: QuerySession,
  args: { query?: string; date_from?: string; date_to?: string; limit?: number }
): Promise<string> {
  const blocked = await requireIndex(store, session);
  if (blocked) {
    return blocked;
  }
  const query = (args.query || "").trim();
  if (!query) {
    return "Error: query is required for plaud_search";
  }
  const [vector] = await embedder.embed([query]);
  const hits = await store.search(vector, {
    limit: args.limit,
    dateFrom: args.date_from,
    dateTo: args.date_to
  });
  return formatSearchResults(hits);
}

export async function runPlaudGet(
  store: VectorStore,
  session: QuerySession,
  args: { file_id?: string; note_id?: string }
): Promise<string> {
  const blocked = await requireIndex(store, session);
  if (blocked) {
    return blocked;
  }
  const fileId = (args.file_id || args.note_id || "").trim();
  if (!fileId) {
    return "Error: file_id is required for plaud_get";
  }
  const view = await store.getFile(fileId);
  return formatGetResult(view);
}

export const TOOL_DEFINITIONS = [
  {
    name: "plaud_search",
    description:
      "Semantic search over the local Plaud index. Returns Plaud file_ids with title, date, score, and a short snippet. Does not return full transcripts. Use remote Plaud MCP get_transcript/get_note with the file_id for full text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        date_from: {
          type: "string",
          description: "Optional inclusive start date YYYY-MM-DD"
        },
        date_to: {
          type: "string",
          description: "Optional inclusive end date YYYY-MM-DD"
        },
        limit: { type: "number", description: "Max files to return (default 8, max 25)" }
      },
      required: ["query"]
    }
  },
  {
    name: "plaud_get",
    description:
      "Look up a Plaud recording by file_id in the local index. Returns metadata and short snippets only — not a full transcript dump. For full text, call remote Plaud MCP get_file / get_note / get_transcript with the same file_id.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Plaud recording / file id" }
      },
      required: ["file_id"]
    }
  }
] as const;
