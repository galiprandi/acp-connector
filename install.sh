#!/bin/sh
# assistant-setup installer — downloads the right binary for this OS/arch.
# Usage: curl -fsSL https://raw.githubusercontent.com/galiprandi/acp-connector/main/install.sh | sh
set -e

REPO="galiprandi/acp-connector"
BIN="assistant-setup"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)  FILE="${BIN}-linux-x64" ;;
  Darwin*)
    case "$ARCH" in
      arm64) FILE="${BIN}-macos-arm64" ;;
      *)     FILE="${BIN}-macos-x64" ;;
    esac ;;
  MINGW*|MSYS*|CYGWIN*)
    FILE="${BIN}-windows-x64.exe" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep "browser_download_url.*${FILE}" \
  | cut -d '"' -f 4)

if [ -z "$URL" ]; then
  echo "Could not find $FILE in latest release."
  exit 1
fi

echo "Downloading $FILE..."
curl -fSL -o "$BIN" "$URL"
chmod +x "$BIN"

echo ""
echo "✓ Downloaded ./$BIN"
echo "Run it:  ./$BIN"
