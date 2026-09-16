#!/bin/sh
# Load PLAUD_API_TOKEN from macOS Keychain, then exec the indexer.
# Do not put the token in this file, the LaunchAgent plist, or git.
#
# Create the Keychain item once:
#   security add-generic-password -s plaud-index-mcp -a plaud-api -w
#
# Replace node / package paths with `which node` and `npm root -g`.

set -eu
TOKEN="$(security find-generic-password -s plaud-index-mcp -a plaud-api -w)"
export PLAUD_API_TOKEN="$TOKEN"
exec /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/plaud-index-mcp/dist/cli.js --mode=indexer
