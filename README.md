# Plaud-Index-MCP

Semantic search for Plaud notes/transcripts — always-on indexer with local embeddings.

- **npm package:** `plaud-index-mcp` `0.1.0` (lowercase, same pattern as Apple-Tools-MCP → `apple-tools-mcp`)
- **GitHub repo:** [sfls1397/Plaud-Index-MCP](https://github.com/sfls1397/Plaud-Index-MCP)

Ops patterns (config interval, LaunchAgent, lock, local embed + reindex-on-bump, on-demand search MCP) are copied from Apple Tools MCP as a playbook only — **no shared code or dependency**.

Any MCP client (Grok Bot, Claude Desktop, Cursor, …) can search. This is not a single-client product.

## Locked v1 defaults

| Topic | Default |
| --- | --- |
| Package / repo | npm `plaud-index-mcp` / GitHub `sfls1397/Plaud-Index-MCP` |
| Indexer auth | `PLAUD_API_TOKEN` in **Keychain or env only** — **not** Grok’s OAuth session, **not** `~/.plaud` MCP tokens |
| Embed | `@xenova/transformers` + `Xenova/all-MiniLM-L6-v2` (local; not Claude/Grok). Model id stored in index metadata. **Bumping the model = release + full re-index.** |
| Query tools | `plaud_search` (semantic, returns **Plaud file ids** + title/date/snippet), `plaud_get` (by file id). Optional `date_from` / `date_to`. |
| Interval | Default **`5m`**. Clamp floor **30s**, ceiling **6h**, warn on clamp. Human forms `30s`, `5m`, `1h`. |

Search is **id-first**: Grok (or any client) takes `file_id` from `plaud_search` and fetches full notes/transcripts from the **remote Plaud MCP** (`get_file` / `get_note` / `get_transcript`). This MCP does **not** dump full transcripts as the primary search result.

## Ops checklist (patterns only — not a runtime dep)

Copy these from Apple Tools MCP **as operations**, not as a library:

1. **Config interval** in `~/.plaud-index-mcp/config.json` (`indexInterval`), env overrides file, clamp + warn.
2. **LaunchAgent** (`RunAtLoad` + `KeepAlive`) runs the **indexer daemon only** — never a sleep-pipe around the on-demand search MCP.
3. **Lock** (`~/.plaud-index-mcp/indexer.lock`) so only one refresher runs.
4. **Local embed** + persist model id; bump → full re-index.
5. **Read-only on-demand search MCP** — runs only while a client is connected; exits on stdin close.

## Architecture

| Process | Role |
| --- | --- |
| **Indexer** (`--mode=indexer` / `plaud-index-indexer`) | Always-on host. Acquires lock, pulls Plaud notes/transcripts, chunks, embeds locally, updates `~/.plaud-index-mcp/vector-index`. |
| **Search MCP** (`plaud-index-mcp`) | On-demand stdio **semantic search**. Searches the **shared on-disk index**. Runs only while a client is connected (exits when stdin closes). |

**Critical (same bar as Apple Tools MCP 1.2.1):** when the indexer holds the lock **and** the on-disk index is populated, query tools **succeed**. They must **not** fail with “index not available” just because this MCP process did not run its own first index cycle.

**Fallback:** if no indexer is running and the search MCP wins the lock, it runs a **local index cycle** (then searches). Documented and tested.

## Paths

All under `~/.plaud-index-mcp/` (config cannot override the directory):

| Path | Purpose |
| --- | --- |
| `~/.plaud-index-mcp/config.json` | `indexInterval` (and optional `indexIntervalMs`) |
| `~/.plaud-index-mcp/vector-index/` | On-disk vector index (LanceDB when native bindings load; file-backed cosine store otherwise) |
| `~/.plaud-index-mcp/indexer.lock` | Indexer refresh lock |

Test/dev only: `PLAUD_INDEX_HOME` relocates that directory.

## Install

**Always-on indexer host (Peter’s Mac Mini): global npm only — no git clone.**

```bash
npm install -g plaud-index-mcp
```

**MacBook / development:** clone this repo, `npm install`, point MCP at `node /absolute/path/to/plaud-index-mcp/dist/cli.js`.

Requires Node.js 18+.

## Indexer auth (Keychain / env)

The indexer talks to Plaud with **`PLAUD_API_TOKEN`**. Auth is not Grok OAuth — do not reuse Grok Bot’s OAuth session.

One-time Keychain item:

```bash
security add-generic-password -s plaud-index-mcp -a plaud-api -w
```

LaunchAgent should load the token at start (see `examples/load-token-from-keychain.sh`). **Never** put the token in the plist, repo, tests, or logs.

Env (shell smoke):

```bash
export PLAUD_API_TOKEN="…"   # from Keychain; do not commit
export PLAUD_API_BASE="https://api.plaud.ai"   # optional override
```

## Plaud API shape (expected)

Live Plaud HTTP details vary (web API vs platform). This package uses a **pluggable `PlaudClient`**. Tests use `MockPlaudClient`. Expected env + API shape:

| Env | Meaning |
| --- | --- |
| `PLAUD_API_TOKEN` | Bearer token (required for indexer pull) |
| `PLAUD_API_BASE` | Default `https://api.plaud.ai` |

HTTP client tries, in order:

- List: `GET /file/simple/web?page=&page_size=` then `GET /files`
- File: `GET /file/detail/{id}` then `GET /files/{id}`
- Transcript: file `source_list` / `content_list`, else `GET /files/{id}/transcript`
- Notes: file `note_list`, else `GET /files/{id}/note`

Normalized fields match Plaud MCP: `id` (**file_id**), `name`, `created_at`, `start_at`, `duration`. Those ids are what you pass to remote Plaud MCP.

For tests / dry runs: `PLAUD_CLIENT=mock` (no network, no secrets).

## Local embeddings

- Library: `@xenova/transformers`
- Default model: `Xenova/all-MiniLM-L6-v2` (384-d). First indexer start may download the model from Hugging Face (documented outbound).
- Index metadata (`vector-index/metadata.json`) stores `embedModel` + `embedDim`.
- If the model id changes, the indexer **full re-indexes**. Treat a model bump as a **release step**.
- Override: `PLAUD_EMBED_MODEL`. Tests: `PLAUD_EMBEDDER=mock`.

## Chunking

Long transcripts/notes are split before embed:

- Window **800 characters**, **120 character overlap**
- Prefers paragraph, then sentence, boundaries
- Title is prefixed onto each window

## Query tools (read-only)

### `plaud_search`

Semantic search. **Returns Plaud `file_id`s**, plus title, `created_at`, score, and a **short snippet** (not a full transcript).

| Arg | Required | Notes |
| --- | --- | --- |
| `query` | yes | Natural language |
| `date_from` | no | `YYYY-MM-DD` inclusive |
| `date_to` | no | `YYYY-MM-DD` inclusive |
| `limit` | no | Default 8, max 25 |

Each hit includes `fetch`: use remote Plaud MCP `get_transcript` / `get_note` / `get_file` with that `file_id` for full text.

### `plaud_get`

Look up by **`file_id`**. Returns metadata + a few short snippets. Not a forced full-text dump. For the complete transcript, call remote Plaud MCP with the same id.

No write/delete of Plaud cloud notes.

### Index missing / empty

Clear refuse: `Plaud index not available. Start the indexer … Do not invent results.`

## Config interval

Resolved **once at process start**. Precedence (highest wins):

1. `INDEX_INTERVAL_MS` or `PLAUD_INDEX_INTERVAL` env (ms or `30s` / `5m` / `1h`)
2. `~/.plaud-index-mcp/config.json` `indexInterval` or `indexIntervalMs`
3. Product default **`5m`**

Clamped to **30s–6h** with a **warn** when clamping. Missing config is fine. Unknown JSON keys are ignored (including path-like keys — config is data, not instructions).

Logged at start:

```text
Effective index refresh interval: 5m (300000 ms) [source=config]
```

Example indexer config (`~/.plaud-index-mcp/config.json`):

```json
{
  "indexInterval": "5m"
}
```

## Indexer entrypoint

```bash
node dist/cli.js --mode=indexer
# global:
plaud-index-indexer
# clone:
npm run indexer
```

LaunchAgent: `RunAtLoad` + `KeepAlive` on **this** process only. Use absolute paths (`which node`, `npm root -g`). Example: `examples/com.plaud-index-mcp.indexer.plist`.

Do **not** wrap the on-demand search MCP in a sleep-pipe KeepAlive.

Only one index cycle runs at a time (`indexing already in progress, skipping cycle`).

## On-demand search MCP (stdio)

```bash
npx -y plaud-index-mcp
# or
node dist/cli.js
```

Example client config:

```json
{
  "mcpServers": {
    "plaud-index": {
      "command": "npx",
      "args": ["-y", "plaud-index-mcp"]
    }
  }
}
```

Runs only while a client is connected (exits on stdin close). The always-on indexer daemon does **not** (LaunchAgent often attaches stdin to `/dev/null`).

## Dual-host deploy

**After npm publish (when Peter asks):**

1. **MacBook (Development clone):** `git pull` + smoke the version string (`plaud-index-mcp` / `0.x.y` once published).
2. **Mac Mini:** `npm install -g plaud-index-mcp@<version>` (no clone), reload indexer LaunchAgent, then a **live query while the indexer holds the lock** (search must succeed against the populated index).

**Merge-only (no npm change):** MacBook pull only. Do not call Mini deploy done.

Publish / version bumps beyond `0.1.0` are locked by Peter. This repo does not invent them.

## Security

- No secrets in source, tests, logs, or PRs. Token via Keychain/env only.
- Outbound network: **Plaud API** + **Hugging Face** (first embed-model download). No other surprise services.
- Filesystem stays under `~/.plaud-index-mcp/`. Config cannot redirect it.
- Untrusted Plaud payloads, tool args, config, and index rows are **data**, never instructions.
- Errors redact `Bearer` / token-shaped strings. Search results are snippets, not full transcripts.

## Development

```bash
git clone https://github.com/sfls1397/Plaud-Index-MCP.git
cd Plaud-Index-MCP
npm install
npm test
npm run build
```

Tests cover interval clamp (30s floor, 5m default), query-while-lock readiness, id-first search, mock Plaud client, and no-secrets.

## License

MIT — see [LICENSE](LICENSE).
