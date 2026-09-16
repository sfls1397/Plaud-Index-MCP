import path from "node:path";

export type CliCommand = "login" | "logout" | "indexer" | "mcp";

/**
 * Canonical indexer entry: `node dist/cli.js --mode=indexer`
 * Convenience bin: `plaud-index-indexer` (same file; detected via argv[1]).
 * Auth: `plaud-index-mcp login` / `logout`.
 * Query MCP stdio is the default when neither is present.
 */
export function isIndexerMode(argv: string[] = process.argv): boolean {
  if (getCliCommand(argv) === "indexer") {
    return true;
  }
  return false;
}

export function getCliCommand(argv: string[] = process.argv): CliCommand {
  if (!Array.isArray(argv) || argv.length === 0) {
    return "mcp";
  }
  const positionals = positionalArgs(argv);
  if (positionals[0] === "login") {
    return "login";
  }
  if (positionals[0] === "logout") {
    return "logout";
  }
  if (argv.includes("--mode=indexer")) {
    return "indexer";
  }
  const modeIdx = argv.indexOf("--mode");
  if (modeIdx !== -1 && argv[modeIdx + 1] === "indexer") {
    return "indexer";
  }
  const entry = argv[1] ? path.basename(argv[1]) : "";
  if (entry === "plaud-index-indexer") {
    return "indexer";
  }
  return "mcp";
}

export function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      continue;
    }
    out.push(a);
  }
  return out;
}
