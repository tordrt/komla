#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# generate-checksums.sh — Generate SHA256 checksums for release artifacts
#
# Usage:
#   bash scripts/generate-checksums.sh [version]
#
# If version is not provided, reads from package.json.
# Outputs SHA256SUMS file in dist/ with versioned filenames matching R2 uploads.
# ---------------------------------------------------------------------------

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
VERSION="${1:-$(node -p "require('$PROJECT_ROOT/package.json').version")}"

CHECKSUMS_FILE="$DIST_DIR/SHA256SUMS"
> "$CHECKSUMS_FILE"

# Generate checksum for an artifact if it exists
checksum_artifact() {
  local name="$1"
  if [[ -f "$DIST_DIR/$name" ]]; then
    hash=$(shasum -a 256 "$DIST_DIR/$name" | cut -d' ' -f1)
    echo "${hash}  ${name}" >> "$CHECKSUMS_FILE"
  fi
}

checksum_artifact "komla-${VERSION}-arm64.zip"
checksum_artifact "komla-${VERSION}-x64.zip"
checksum_artifact "komla-${VERSION}-arm64.dmg"
checksum_artifact "komla-${VERSION}-x64.dmg"
checksum_artifact "komla-${VERSION}-x64-setup.exe"
checksum_artifact "komla-${VERSION}-arm64-setup.exe"
checksum_artifact "komla-${VERSION}-x64-setup.zip"
checksum_artifact "komla-${VERSION}-arm64-setup.zip"
checksum_artifact "komla-${VERSION}-x86_64.AppImage"
checksum_artifact "komla-${VERSION}-arm64.AppImage"

# Sort for consistent output
if [[ -s "$CHECKSUMS_FILE" ]]; then
  sort -k2 "$CHECKSUMS_FILE" -o "$CHECKSUMS_FILE"
  echo "Generated checksums for $(wc -l < "$CHECKSUMS_FILE" | tr -d ' ') artifacts in $CHECKSUMS_FILE"
else
  echo "warning: No artifacts found in $DIST_DIR"
fi
