#!/usr/bin/env bash
# Compile assistant-setup into single-file binaries via `bun build --compile`.
# Outputs land in dist/wizard/.
set -euo pipefail
cd "$(dirname "$0")/.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
OUT=dist/wizard
ENTRY=src/setup/wizard.ts
mkdir -p "$OUT"

targets=(
  "bun-linux-x64:assistant-setup-linux-x64"
  "bun-darwin-arm64:assistant-setup-macos-arm64"
  "bun-windows-x64:assistant-setup-windows-x64.exe"
)

for t in "${targets[@]}"; do
  target="${t%%:*}"
  out="${t##*:}"
  echo "Building $out ($target)"
  "$BUN" build --compile --target="$target" "$ENTRY" --outfile "$OUT/$out"
done

echo "Done. Binaries in $OUT/"
