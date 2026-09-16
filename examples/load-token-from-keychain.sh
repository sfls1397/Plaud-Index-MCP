#!/bin/sh
# LaunchAgent wrapper: keep the indexer in the logged-in user session so
# macOS Keychain is reachable. The Node process reads Keychain itself —
# this script does not print or export secrets.
#
# Shareable path (after `plaud-index-mcp login`):
#   service  plaud-index-mcp
#   account  plaud-mcp
#   value    JSON { access_token, refresh_token, token_type, expires_at }
#
# Optional Bearer-only override (NOT the shareable happy path):
#   env PLAUD_API_TOKEN, or Keychain account plaud-api (used only when no OAuth session)
#
# Do not put tokens in this file, the LaunchAgent plist, or git.
# Sign in once on this host: plaud-index-mcp login
#
# Replace node / package paths with `which node` and `npm root -g`.

set -eu
exec /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/plaud-index-mcp/dist/cli.js --mode=indexer
