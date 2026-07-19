#!/usr/bin/env sh
# mcpmux installer: puts the mux binary into ~/.local/bin.
set -eu
REPO="${MCPMUX_REPO:-OWNER/mcpmux}"   # set on first GitHub release
BIN_DIR="${MCPMUX_BIN_DIR:-$HOME/.local/bin}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"; [ "$ARCH" = "aarch64" ] && ARCH="arm64"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
URL="https://github.com/$REPO/releases/latest/download/mux-$OS-$ARCH"
mkdir -p "$BIN_DIR"
curl -fsSL "$URL" -o "$BIN_DIR/mux"
chmod +x "$BIN_DIR/mux"
echo "installed: $BIN_DIR/mux (run: mux help)"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "NOTE: add $BIN_DIR to PATH";; esac
