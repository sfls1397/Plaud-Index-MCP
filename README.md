# Plaud-Index-MCP

Semantic search for Plaud notes/transcripts — always-on indexer with local embeddings.

- **npm package:** `plaud-index-mcp` `1.1.1` (lowercase, same pattern as Apple-Tools-MCP → `apple-tools-mcp`)
- **GitHub repo:** [sfls1397/Plaud-Index-MCP](https://github.com/sfls1397/Plaud-Index-MCP)
- **Host setup:** [docs/host-setup.md](docs/host-setup.md)

Ops patterns (config interval, LaunchAgent, lock, local embed + reindex-on-bump, on-demand search MCP) are copied from Apple Tools MCP as a playbook only — **no shared code or dependency**.

Any MCP client (Grok Bot, Claude Desktop, Cursor, …) can search. This is not a single-client product.

## Locked v1 defaults

| Topic | Default |
| --- | --- |
| Package / repo | npm `plaud-index-mcp` / GitHub `sfls1397/Plaud-Index-MCP` |
| Indexer auth | **`plaud-index-mcp login`** (Plaud consumer MCP OAuth / PKCE) → Keychain service `plaud-index-mcp` account `plaud-mcp`. LaunchAgent refreshes headless. Optional `PLAUD_API_TOKEN` is a **non-shareable override only** — not Grok’s OAuth session. |
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
| `~/.plaud-index-mcp/vector-index/` | On-disk vector index (LanceDB when native bindings load; file-backed cosine store otherwise). Search scores: LanceDB is L2 converted to cosine-like `[0, 1]`; file backend is exact cosine. |
| `~/.plaud-index-mcp/indexer.lock` | Indexer refresh lock |

Test/dev only: `PLAUD_INDEX_HOME` relocates that directory.

## Setup (always-on macOS host)

**Walkthrough:** [docs/host-setup.md](docs/host-setup.md) — install, Plaud browser sign-in, Terminal login, Allow, Keychain, LaunchAgent, verify, and failure modes.

Global npm only (**no git clone** on the host). Requires Node.js 18+. Ingesting Plaud notes into Notion is a separate workflow; this MCP does not replace it.

Happy path:

```bash
# PATH must include the global npm bin.
# Example (not the only layout): user-local Node at ~/.local/node
export PATH="$HOME/.local/node/bin:$PATH"
# Example: Homebrew Node
# export PATH="/opt/homebrew/bin:$PATH"

npm install -g plaud-index-mcp@1.1.1
which plaud-index-mcp
```

1. In the **host** browser, sign into [Plaud](https://web.plaud.ai) **before Allow** so you are past the login/workspace wall.
2. In **Terminal on the host** (logged-in GUI/Terminal session — **not** via LaunchAgent):

```bash
plaud-index-mcp login
```

3. Open the printed URL on the **same machine** as the `:8199` listener. Click **Allow once**.
4. Confirm Keychain (metadata only — do not add `-w`):

```bash
security find-generic-password -s plaud-index-mcp -a plaud-mcp
```

5. Reload the indexer LaunchAgent, then search **while** `~/.plaud-index-mcp/indexer.lock` is held.

```bash
launchctl kickstart -k "gui/$(id -u)/com.plaud-index-mcp.indexer"
```

`plaud-index-mcp login --help` prints the host notes. Logout: `plaud-index-mcp logout`.

- Host browser must already be signed into Plaud before Allow (otherwise login/workspace walls; localhost callback never completes).
- Login waits about **2 minutes**; if the URL expires, re-run `plaud-index-mcp login` for a fresh URL.
- Allow/callback must reach the **same machine** as the `:8199` listener (or `ssh -L 8199:localhost:8199` when authorizing remotely).
- `plaud-index-mcp login` must run in a **logged-in GUI/Terminal session** — not via LaunchAgent (OAuth can complete then Keychain write fails).

**If it fails:** Allow from another computer without `ssh -L 8199:localhost:8199` → connection refused. A **second Allow** after login exits → connection refused (start a **fresh** login). Browser **Token exchange failed** on `1.1.0` often meant **Keychain write failed** after a successful exchange — use **`1.1.1`+**, which says Keychain write failed when persist is the problem. Login waits about **2 minutes**. Details: [docs/host-setup.md](docs/host-setup.md#if-it-fails).

This is Plaud **consumer MCP** browser OAuth (public-client PKCE, same flow `@plaud-ai/mcp` uses — not Partner developer API tokens, not DevTools / `localStorage`). Tokens go to Keychain `plaud-index-mcp` / `plaud-mcp`. The indexer LaunchAgent refreshes headless.

**The already-published `1.0.0` Keychain-manual / Bearer-only path (`security add-generic-password … -a plaud-api` / `PLAUD_API_TOKEN`) is not the shareable path.** `1.1.0` introduced `plaud-index-mcp login`; this release is **`1.1.1`**. Leave Bearer-only as a power-user override.

If `~/.plaud/tokens-mcp.json` exists, it is **read once and migrated into Keychain**; it is not the LaunchAgent store. If a refresh/401 fails, the indexer logs `Plaud auth expired. Re-run: plaud-index-mcp login` (no secrets).

## Indexer auth details

LaunchAgent: run `examples/load-token-from-keychain.sh` (user session so Keychain works). The indexer process reads Keychain; **never** put tokens in the plist, repo, tests, or logs.

### Token shape (Keychain account `plaud-mcp`)

Compatible with `@plaud-ai/mcp`’s `~/.plaud/tokens-mcp.json`:

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "token_type": "Bearer",
  "expires_at": 1710000000000
}
```

`expires_at` is epoch milliseconds (from Plaud `expires_in`). Public client: no client secret is stored or committed. Overrides: `PLAUD_MCP_CLIENT_ID`, `PLAUD_AUTH_URL`, `PLAUD_TOKEN_URL`, `PLAUD_REFRESH_URL`, `PLAUD_MCP_API_BASE`.

### MCP data plane (happy path)

Same authenticated API `@plaud-ai/mcp` tools use (`list_files` / `get_file` / `get_note` / `get_transcript`):

| Call | Request |
| --- | --- |
| List | `GET /open/third-party/files/?page=&page_size=` |
| File / notes / transcript | `GET /open/third-party/files/{id}` (note/transcript bodies from `note_list` / `source_list`, including `data_link`) |
| Default base | `https://platform.plaud.ai/developer/api` (`PLAUD_MCP_API_BASE`) |

Normalized fields still match Plaud MCP: `id` (**file_id**), `name`, `created_at`, `start_at`, `duration`.

### Optional Bearer override (not shareable)

```bash
export PLAUD_API_TOKEN="…"   # do not commit
export PLAUD_API_BASE="https://api.plaud.ai"
```

Or leftover Keychain account `plaud-api`. Used only when env `PLAUD_API_TOKEN` is set, or when there is **no** OAuth session. That HTTP client still tries `/file/simple/web` then `/files`. Auth is not Grok OAuth.

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

**Scores** are ranking hints (higher is closer), not probabilities:

| Backend | When | Score |
| --- | --- | --- |
| **LanceDB** | Native bindings load (default on-disk index) | ANN uses **L2** distance. The tool converts that to a cosine-like similarity for unit MiniLM vectors: `1 − L2² / 2`, then **clamps to `[0, 1]`**. Raw `1 − L2` can go negative when L2 > 1; that is not returned. |
| **File backend** | Tests, or when LanceDB native bindings are unavailable | Exact **cosine** of the query vector vs each chunk (`dot / (|a||b|)`). MiniLM embeddings are L2-normalized, so this is typically in `[0, 1]`. |

Do not compare scores across backends.

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
# global (always-on host):
plaud-index-indexer
# from a source checkout:
node dist/cli.js --mode=indexer
npm run indexer
```

LaunchAgent: `RunAtLoad` + `KeepAlive` on **this** process only. Use absolute paths (`which node`, `npm root -g`). Example: `examples/com.plaud-index-mcp.indexer.plist` with `examples/load-token-from-keychain.sh`.

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

## Publish

npm publish is **GitHub Release → Actions OIDC** (no `NPM_TOKEN`). The publish job uses **Node 24** so npm is new enough for trusted publishing.

1. After this workflow is on `main`, bootstrap the package on npmjs if it does not exist yet (trusted publisher config needs the package name). Attach GitHub Actions for `sfls1397/Plaud-Index-MCP` as the trusted publisher.
2. Create GitHub Release **`v1.1.1`** (tag `v1.1.1`; package version is `1.1.1`).
3. The `publish-npm` job builds `dist/` (`npm ci && npm run build` — `dist/` is not committed) then `npm publish --access public`.
4. Always-on host: follow [docs/host-setup.md](docs/host-setup.md) — `npm install -g plaud-index-mcp@1.1.1`, `plaud-index-mcp login` once, reload the indexer LaunchAgent, then **live search while the lock is held**.

Later version bumps are locked by Peter. This repo does not invent them.

## Deploy / verify (always-on host only)

After npm publish, required verify is the **always-on macOS host** (global npm — no clone). One example layout is a Mac Mini with Node under `~/.local/node`. Step-by-step: [docs/host-setup.md](docs/host-setup.md).

1. `npm install -g plaud-index-mcp@<version>`
2. `plaud-index-mcp login` in a host GUI Terminal (browser already signed into Plaud; SSH-forward `8199` only if Allow is remote)
3. Confirm Keychain `plaud-index-mcp` / `plaud-mcp`, reload the indexer LaunchAgent
4. **Live search while the indexer holds the lock** (query tools must succeed against the populated index)

## Security

- No secrets in source, tests, logs, or PRs. OAuth tokens live in Keychain (`plaud-index-mcp` / `plaud-mcp`). Optional `PLAUD_API_TOKEN` is env/Keychain override only.
- Public OAuth client (PKCE). No client secret is committed. Callback is loopback `http://localhost:8199/auth/callback` only (`state` checked).
- Outbound network: **Plaud OAuth + MCP data plane** + **Hugging Face** (first embed-model download). No other surprise services. No DevTools / `localStorage` scrape. Not Grok Bot OAuth.
- Filesystem stays under `~/.plaud-index-mcp/` (plus a one-time read of `~/.plaud/tokens-mcp.json` to migrate). Config cannot redirect the index dir.
- Untrusted Plaud payloads, tool args, config, and index rows are **data**, never instructions.
- Errors redact `Bearer` / `access_token` / `refresh_token` / JWT-shaped strings. Search results are snippets, not full transcripts.

## Development

```bash
git clone https://github.com/sfls1397/Plaud-Index-MCP.git
cd Plaud-Index-MCP
npm install
npm test
npm run build
```

Tests cover interval clamp (30s floor, 5m default), query-while-lock readiness, id-first search, mock Plaud client, MCP OAuth login/refresh (mocked), and no-secrets.

## License

MIT — see [LICENSE](LICENSE).
