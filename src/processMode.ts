import path from "node:path";

/**
 * Canonical indexer entry: `node dist/cli.js --mode=indexer`
 * Convenience bin: `plaud-index-indexer` (same file; detected via argv[1]).
 * Query MCP stdio is the default when neither is present.
 */
export function isIndexerMode(argv: string[] = process.argv): boolean {
  if (!Array.isArray(argv) || argv.length === 0) {
    return false;
  }
  if (argv.includes("--mode=indexer")) {
    return true;
  }
  const modeIdx = argv.indexOf("--mode");
  if (modeIdx !== -1 && argv[modeIdx + 1] === "indexer") {
    return true;
  }
  const entry = argv[1] ? path.basename(argv[1]) : "";
  return entry === "plaud-index-indexer";
}
