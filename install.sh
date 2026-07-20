#!/usr/bin/env sh
# mcpmux installer: fetch the mux binary into ~/.local/bin, verifying its checksum.
set -eu
REPO="${MCPMUX_REPO:-TheFox666/mcpmux}"  # override with MCPMUX_REPO if you fork
BIN_DIR="${MCPMUX_BIN_DIR:-$HOME/.local/bin}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"; [ "$ARCH" = "aarch64" ] && ARCH="arm64"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
ASSET="mux-$OS-$ARCH"
BASE="https://github.com/$REPO/releases/latest/download"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "downloading $ASSET…"
curl -fsSL "$BASE/$ASSET" -o "$tmp/mux"
# checksum: <asset>.sha256 ships next to the release asset (one line: "<sha256>  <asset>")
if curl -fsSL "$BASE/$ASSET.sha256" -o "$tmp/mux.sha256" 2>/dev/null; then
  want="$(cut -d' ' -f1 < "$tmp/mux.sha256")"
  got="$(sha256sum "$tmp/mux" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$tmp/mux" | cut -d' ' -f1)"
  if [ "$want" != "$got" ]; then
    echo "CHECKSUM MISMATCH — refusing to install (want $want, got $got)" >&2
    exit 1
  fi
  echo "checksum ok"
else
  echo "WARNING: no .sha256 published for $ASSET — installing UNVERIFIED" >&2
fi

mkdir -p "$BIN_DIR"
mv "$tmp/mux" "$BIN_DIR/mux"
chmod +x "$BIN_DIR/mux"
echo "installed: $BIN_DIR/mux (run: mux help)"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "NOTE: add $BIN_DIR to PATH";; esac
