#!/usr/bin/env bash
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${SESSIONS_INSTALL_BIN:-$HOME/.local/bin}"
ENTRYPOINT="$SKILL_ROOT/scripts/sessions.ts"

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "sessions requires Node >=24." >&2
    exit 1
  fi

  if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 24 ? 0 : 1);'; then
    echo "sessions requires Node >=24. Found $(node --version)." >&2
    exit 1
  fi
}

install_dependencies() {
  if command -v pnpm >/dev/null 2>&1; then
    local pnpm_major
    pnpm_major="$(pnpm --version | cut -d. -f1)"
    if [[ "$pnpm_major" =~ ^[0-9]+$ && "$pnpm_major" -ge 9 ]]; then
      (cd "$SKILL_ROOT" && pnpm install --prod --frozen-lockfile)
      return
    fi
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack prepare pnpm@11.9.0 --activate >/dev/null
    (cd "$SKILL_ROOT" && corepack pnpm install --prod --frozen-lockfile)
    return
  fi

  echo "sessions requires pnpm to install skill-local dependencies." >&2
  echo "Install pnpm or enable Corepack, then rerun: $0" >&2
  exit 1
}

require_node
install_dependencies
mkdir -p "$BIN_DIR"
ln -sf "$ENTRYPOINT" "$BIN_DIR/sessions"
chmod +x "$ENTRYPOINT"
echo "Installed sessions: $BIN_DIR/sessions"
echo "Entrypoint: $ENTRYPOINT"
echo "Dependencies: $SKILL_ROOT/node_modules"
