#!/usr/bin/env bash
# Compile assistant-setup into single-file binaries via `bun build --compile`.
# Outputs land in dist/wizard/.
set -euo pipefail
cd "$(dirname "$0")/.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
OUT=dist/wizard
ENTRY=src/setup/wizard.ts
BRIDGE_ENTRY=src/index.ts
mkdir -p "$OUT"

targets=(
  "bun-linux-x64:assistant-setup-linux-x64:acp-connector-linux-x64"
  "bun-darwin-arm64:assistant-setup-macos-arm64:acp-connector-macos-arm64"
  "bun-windows-x64:assistant-setup-windows-x64.exe:acp-connector-windows-x64.exe"
)

for t in "${targets[@]}"; do
  target="$(cut -d: -f1 <<<"$t")"
  wiz="$(cut -d: -f2 <<<"$t")"
  bridge="$(cut -d: -f3 <<<"$t")"
  echo "Building $wiz ($target)"
  "$BUN" build --compile --target="$target" "$ENTRY" --outfile "$OUT/$wiz"
  echo "Building $bridge ($target)"
  "$BUN" build --compile --target="$target" "$BRIDGE_ENTRY" --outfile "$OUT/$bridge"
done

echo "Done. Binaries in $OUT/"
