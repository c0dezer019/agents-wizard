#!/bin/bash
# Installer for agents-wizard. Symlinks agents-wizard.js into a bin dir on
# PATH so `lsagents` runs from anywhere.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/agents-wizard.js"
BIN_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/lsagents"

if [ ! -f "$TARGET" ]; then
  echo "error: agents-wizard.js not found in $SCRIPT_DIR" >&2
  exit 1
fi

chmod +x "$TARGET"
mkdir -p "$BIN_DIR"
ln -sf "$TARGET" "$LINK"

echo "Linked: $LINK -> $TARGET"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh) RC="~/.zshrc" ;;   # default shell on macOS
      */bash) RC="~/.bashrc (or ~/.bash_profile on macOS)" ;;
      *) RC="your shell rc file" ;;
    esac
    echo
    echo "warning: $BIN_DIR not on PATH. Add to $RC:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo "Run 'lsagents' to start. 'lsagents --update' pulls the latest from the repo."
