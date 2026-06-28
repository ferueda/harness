#!/usr/bin/env bash
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${CURSOR_CLI_INSTALL_BIN:-$HOME/.local/bin}"
ENTRYPOINT="$SKILL_ROOT/scripts/cursor-cli.ts"
mkdir -p "$BIN_DIR"
ln -sf "$ENTRYPOINT" "$BIN_DIR/cursor-cli"
chmod +x "$ENTRYPOINT"
echo "Installed cursor-cli: $BIN_DIR/cursor-cli"
echo "Entrypoint: $ENTRYPOINT"
echo "Direct run: node \"$ENTRYPOINT\" --help"
