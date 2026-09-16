# Always-on host setup

Install, sign in, and verify **plaud-index-mcp** on an always-on **macOS** host. Global npm only — no git clone on the host.

Ingesting Plaud notes into Notion is a **separate** workflow. This package is local semantic search over an on-host index; it does not replace that ingest.

**This release is `1.1.1`.** Use `@1.1.1` (or later). `1.1.0` is already on npm; it can complete OAuth Allow then fail to persist tokens to Keychain.

## Happy path

Do these in order. Stay at the host for the Allow click (~2 minutes).

1. **Install** the global package (PATH must include the global npm bin).
2. **Sign into Plaud** in the host browser (`https://web.plaud.ai`) so you are past the login/workspace wall.
3. In **Terminal on the host** (logged-in GUI session — **not** LaunchAgent): `plaud-index-mcp login`.
4. Open the printed URL on the **same machine** as the `:8199` listener. Click **Allow once**.
5. Confirm Keychain has the item (service `plaud-index-mcp`, account `plaud-mcp`).
6. **Reload** the indexer LaunchAgent.
7. **Verify** search while the indexer holds the lock.

Commands for each step are below.

## Layout

| What | Where |
| --- | --- |
| npm package | global `plaud-index-mcp` (no clone) |
| Config | `~/.plaud-index-mcp/config.json` → `{ "indexInterval": "5m" }` |
| Index | `~/.plaud-index-mcp/vector-index` |
| Lock | `~/.plaud-index-mcp/indexer.lock` |
| LaunchAgent | `com.plaud-index-mcp.indexer` |
| Auth | Keychain service `plaud-index-mcp`, account `plaud-mcp` (OAuth JSON: access + refresh) |

Optional **non-shareable** override only: env `PLAUD_API_TOKEN` or Keychain account `plaud-api`. Do not use that as the normal path.

## 1. Install

Requires Node.js 18+. Put the global npm bin on `PATH`.

```bash
npm install -g plaud-index-mcp@1.1.1
which plaud-index-mcp
plaud-index-mcp login --help   # banner should read (v1.1.1)
```

**PATH examples** (use yours; these are not the only layouts):

```bash
# Example: user-local Node (one always-on host uses ~/.local/node)
export PATH="$HOME/.local/node/bin:$PATH"

# Example: Homebrew Node
export PATH="/opt/homebrew/bin:$PATH"
```

If `which plaud-index-mcp` is empty, the global bin directory is not on `PATH`. Fix that before login.

Write config if missing:

```bash
mkdir -p ~/.plaud-index-mcp
cat > ~/.plaud-index-mcp/config.json <<'EOF'
{
  "indexInterval": "5m"
}
EOF
```

Install the LaunchAgent **after** you have Node paths (step 6). You can sign in (steps 2–5) before the agent is loaded; search results need the indexer running.

## 2. Pre-sign into Plaud in the host browser

On the **host** Chrome or Safari, open `https://web.plaud.ai` and sign in until you see your workspace — not the login wall. Host browser must already be signed into Plaud before Allow.

If you click Allow while the host browser is still on a login/workspace wall, the localhost `:8199` callback never completes.

Also:

- Nothing else should own port **8199**.
- Be at the host ready to click. Login waits about **2 minutes**; if that expires, re-run `plaud-index-mcp login` for a fresh URL.

```bash
lsof -nP -iTCP:8199 -sTCP:LISTEN || true
```

If something is listening, stop the stale `plaud-index-mcp login` (or wait for it to exit) before starting a new one.

## 3. Login from Terminal (not LaunchAgent)

Run this in **Terminal.app** (or iTerm) as the logged-in GUI user on the host. Do **not** run login from LaunchAgent, SSH-without-a-GUI-session, or a background agent.

```bash
plaud-index-mcp login
```

The CLI prints an authorize URL and tries to open a browser. `plaud-index-mcp login --help` prints the same host notes.

## 4. Allow once — same machine as `:8199`

1. Open the printed URL **on this host** (the machine running the `:8199` listener).
2. Click **Allow once**.
3. Browser: **Authorization successful** — you can close the tab and return to the terminal.
4. Terminal: tokens stored in Keychain `plaud-index-mcp` / `plaud-mcp`.

Do **not** click Allow a second time. After success (or after a failed write) the login process has usually already exited.

### Remote Allow (optional)

Only if the browser is **not** on the host:

1. On the host: System Settings → General → Sharing → **Remote Login** on.
2. From the machine with the browser:

```bash
ssh -L 8199:localhost:8199 USER@HOST
```

3. On the host, start `plaud-index-mcp login --no-browser`.
4. On the tunneled machine, open the printed URL. Click **Allow once**.

Without that tunnel, Allow from another computer yields **localhost refused to connect**.

## 5. Confirm Keychain

This prints item metadata only (no `-w`, so the token JSON is not dumped):

```bash
security find-generic-password -s plaud-index-mcp -a plaud-mcp
```

A hit means the OAuth session is in Keychain. Logout:

```bash
plaud-index-mcp logout
```

If `~/.plaud/tokens-mcp.json` already exists from official Plaud MCP, this product **migrates it once** into Keychain. That file is not the LaunchAgent store.

## 6. LaunchAgent (indexer only)

The always-on process is **`plaud-index-indexer`** (`--mode=indexer`): `RunAtLoad` + `KeepAlive`. Do **not** wrap the on-demand search MCP in a sleep-pipe KeepAlive.

Copy the examples from the installed package, then **replace** Node and package paths with `which node` and `npm root -g`:

```bash
PKG="$(npm root -g)/plaud-index-mcp"
which node
npm root -g

mkdir -p ~/.plaud-index-mcp
cp "$PKG/examples/load-token-from-keychain.sh" ~/.plaud-index-mcp/
cp "$PKG/examples/com.plaud-index-mcp.indexer.plist" ~/Library/LaunchAgents/
```

Edit `~/.plaud-index-mcp/load-token-from-keychain.sh` so `exec` points at your Node binary and `$PKG/dist/cli.js --mode=indexer`. Edit the plist `ProgramArguments` and `HOME` / `PATH` to match. **Never** put tokens in the plist, the wrapper, or git.

Load or reload:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.plaud-index-mcp.indexer.plist 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/com.plaud-index-mcp.indexer"
```

The wrapper keeps the indexer in the logged-in user session so Keychain is reachable. The Node process reads Keychain itself; the script does not print or export secrets.

## 7. Verify (after install and after each upgrade)

```bash
# Version banners
plaud-index-mcp login --help
# Indexer stderr should include: Plaud Index MCP indexer running (v1.1.1)

security find-generic-password -s plaud-index-mcp -a plaud-mcp
launchctl kickstart -k "gui/$(id -u)/com.plaud-index-mcp.indexer"

# Indexer log: a cycle should complete without "Plaud auth expired"
tail -n 80 /tmp/plaud-index-indexer.err.log
ls -l ~/.plaud-index-mcp/indexer.lock ~/.plaud-index-mcp/vector-index
```

While the indexer holds `indexer.lock`, run the **on-demand search MCP** (`plaud-index-mcp` with no extra args, or your client config). Expect real `plaud_search` hits — not `Plaud index not available`.

Example client snippet:

```json
{
  "mcpServers": {
    "plaud-index": {
      "command": "plaud-index-mcp",
      "args": []
    }
  }
}
```

If no indexer is running and the search MCP wins the lock, it runs a **local index cycle** then searches (fallback). The normal always-on host keeps the indexer LaunchAgent running.

## If it fails

| What you see | What it usually means | What to do |
| --- | --- | --- |
| Login/workspace wall; callback never completes | Host browser was not signed into Plaud | Sign into `https://web.plaud.ai` on the **host** browser, then a **fresh** `plaud-index-mcp login` |
| `localhost refused to connect` on Allow | Browser is not on the same machine as `:8199` | Allow on the host, or `ssh -L 8199:localhost:8199 USER@HOST` first |
| **Token exchange failed** (especially on `1.1.0`) | OAuth often **did** succeed; **Keychain write** failed | Install **`1.1.1`+**. Re-run login from a GUI Terminal session. `1.1.1` reports **Keychain write failed** when persist is the problem |
| **Keychain write failed** | Authorization succeeded; tokens were not saved | Login from a **logged-in GUI/Terminal** session — not LaunchAgent. Then a **fresh** login URL |
| Second Allow → connection refused | Login process already exited (listener gone) | Do **not** click Allow again. Start a new `plaud-index-mcp login` |
| Timed out after ~2 minutes | Allow was too slow / URL expired | Re-run `plaud-index-mcp login` for a fresh URL |
| `Plaud auth expired. Re-run: plaud-index-mcp login` | Refresh/401 rejected the session | Sign in again from Terminal on the host |
| `Plaud index not available` | Index empty / indexer not running | Finish login, reload LaunchAgent, wait for a cycle, search **while the lock is held** |

On `1.1.0`, Keychain write went through JXA `SecItemAdd` (can return **-50** even after Allow). **`1.1.1`** writes with `security -i` feeding `add-generic-password … -w '<secret>'` on **stdin** (Apple’s `-w -` is the literal password `-`, not stdin). After write, login **reads the item back** and fails with a Keychain-write error if the stored value is `-`, empty, or not the token JSON.

## Auth model (short)

- Shareable path: `plaud-index-mcp login` — Plaud **consumer MCP** public-client PKCE (same flow `@plaud-ai/mcp` uses). Not Partner developer API tokens, not DevTools / `localStorage`.
- LaunchAgent refreshes the access token headlessly until Plaud rejects the refresh.
- `1.0.0` Keychain-manual / Bearer-only (`security add-generic-password … -a plaud-api` / `PLAUD_API_TOKEN`) is **not** the shareable path.
- Do not copy some other app’s OAuth session into this product.
