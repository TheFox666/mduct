#!/usr/bin/env sh
# mduct installer: fetch the mduct binary into ~/.local/bin, verifying its checksum.
set -eu
REPO="${MDUCT_REPO:-TheFox666/mduct}"  # override with MDUCT_REPO if you fork
BIN_DIR="${MDUCT_BIN_DIR:-$HOME/.local/bin}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"; [ "$ARCH" = "aarch64" ] && ARCH="arm64"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
ASSET="mduct-$OS-$ARCH"
BASE="https://github.com/$REPO/releases/latest/download"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "downloading $ASSET…"
curl -fsSL "$BASE/$ASSET" -o "$tmp/mduct"
# checksum: <asset>.sha256 ships next to the release asset (one line: "<sha256>  <asset>")
if curl -fsSL "$BASE/$ASSET.sha256" -o "$tmp/mduct.sha256" 2>/dev/null; then
  want="$(cut -d' ' -f1 < "$tmp/mduct.sha256")"
  got="$(sha256sum "$tmp/mduct" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$tmp/mduct" | cut -d' ' -f1)"
  if [ "$want" != "$got" ]; then
    echo "CHECKSUM MISMATCH — refusing to install (want $want, got $got)" >&2
    exit 1
  fi
  echo "checksum ok"
else
  echo "WARNING: no .sha256 published for $ASSET — installing UNVERIFIED" >&2
fi

mkdir -p "$BIN_DIR"
mv "$tmp/mduct" "$BIN_DIR/mduct"
chmod +x "$BIN_DIR/mduct"
echo "installed: $BIN_DIR/mduct (run: mduct help)"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "NOTE: add $BIN_DIR to PATH";; esac
