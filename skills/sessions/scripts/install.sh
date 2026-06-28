#!/usr/bin/env bash
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${SESSIONS_INSTALL_BIN:-$HOME/.local/bin}"
ENTRYPOINT="$SKILL_ROOT/scripts/sessions.ts"
mkdir -p "$BIN_DIR"
ln -sf "$ENTRYPOINT" "$BIN_DIR/sessions"
chmod +x "$ENTRYPOINT"
echo "Installed sessions: $BIN_DIR/sessions"
echo "Entrypoint: $ENTRYPOINT"
