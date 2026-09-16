import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createEmbedder, type Embedder } from "../embed.js";
import { TOOL_DEFINITIONS, runPlaudGet, runPlaudSearch, type QuerySession } from "./tools.js";
import type { VectorStore } from "../store/types.js";

export function packageVersion(): string {
  const pkgPath = new URL("../../package.json", import.meta.url);
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "0.1.0";
  }
}

export function createQueryServer(options: {
  store: VectorStore;
  embedder: Embedder;
  session: QuerySession;
}): Server {
  const server = new Server(
    { name: "plaud-index-mcp", version: packageVersion() },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    let text: string;
    try {
      if (name === "plaud_search") {
        text = await runPlaudSearch(options.store, options.embedder, options.session, {
          query: typeof args.query === "string" ? args.query : undefined,
          date_from: typeof args.date_from === "string" ? args.date_from : undefined,
          date_to: typeof args.date_to === "string" ? args.date_to : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined
        });
      } else if (name === "plaud_get") {
        text = await runPlaudGet(options.store, options.session, {
          file_id: typeof args.file_id === "string" ? args.file_id : undefined,
          note_id: typeof args.note_id === "string" ? args.note_id : undefined
        });
      } else {
        text = `Unknown tool: ${name}. Read-only tools: plaud_search, plaud_get.`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      text = `Tool error: ${message}`;
    }
    return { content: [{ type: "text", text }] };
  });

  return server;
}

export async function startQueryMcp(options: {
  store: VectorStore;
  session: QuerySession;
  env?: NodeJS.ProcessEnv;
}): Promise<Server> {
  const embedder = await createEmbedder({ env: options.env });
  const server = createQueryServer({
    store: options.store,
    embedder,
    session: options.session
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Plaud Index MCP query server running (v${packageVersion()})`);
  return server;
}

export type { Embedder };
