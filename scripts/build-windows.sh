#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-windows.sh — Build Windows binaries (x64 + arm64) using Wine
#
# Usage:
#   bash scripts/build-windows.sh
#
# Prerequisites:
#   - Wine installed (brew install --cask wine-stable)
#   - App already built (npm run build) - uses existing out/ directory
#
# Note: electron-builder always builds both architectures when both are
# listed in the config, so we build everything in a single invocation.
# ---------------------------------------------------------------------------

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Verify the app has been built
if [[ ! -d "$PROJECT_ROOT/out" ]]; then
  echo "error: out/ directory not found - run 'npm run build' first" >&2
  exit 1
fi

# Find Wine installation
if command -v wine &>/dev/null; then
  WINE_BIN="wine"
elif [[ -x "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine" ]]; then
  export PATH="/Applications/Wine Stable.app/Contents/Resources/wine/bin:$PATH"
  WINE_BIN="wine"
else
  echo "error: Wine not found. Install with: brew install --cask wine-stable" >&2
  exit 1
fi

echo "==> Using Wine: $($WINE_BIN --version)"
echo "==> Building Windows (x64 + arm64)..."

cd "$PROJECT_ROOT"

# Install Windows prebuilt native modules for cross-compilation.
# Unlike node-pty (which ships all platform prebuilds in one package),
# @parcel/watcher uses separate per-platform npm packages and only the
# host platform variant is installed by default.
# Skip if already installed (the release script pre-installs these before
# parallel builds to avoid mutating node_modules/ during concurrent packaging).
if [[ ! -d "$PROJECT_ROOT/node_modules/@parcel/watcher-win32-x64" ]] || [[ ! -d "$PROJECT_ROOT/node_modules/@parcel/watcher-win32-arm64" ]] || \
   [[ ! -d "$PROJECT_ROOT/node_modules/@vscode/ripgrep-win32-x64" ]] || [[ ! -d "$PROJECT_ROOT/node_modules/@vscode/ripgrep-win32-arm64" ]]; then
  echo "==> Installing Windows native module prebuilds..."
  npm install --no-save --force \
    @parcel/watcher-win32-x64 \
    @parcel/watcher-win32-arm64 \
    @vscode/ripgrep-win32-x64 \
    @vscode/ripgrep-win32-arm64
else
  echo "==> Windows native module prebuilds already installed, skipping"
fi

# Build with npmRebuild disabled to use prebuilt native modules
STAGING_ARGS=()
if [[ "${KOMLA_ENV:-}" == "staging" ]]; then
  STAGING_ARGS+=(-c.appId=com.komla.staging "-c.productName=Komla Staging" "-c.nsis.shortcutName=Komla Staging" "-c.nsis.uninstallDisplayName=Komla Staging")
  # The per-user installer names its folder (%LOCALAPPDATA%\Programs\<name>) and
  # updater cache after package.json's name, not productName. Without this, staging
  # and production share one folder and each install overwrites the other's app.asar.
  # artifactName keeps the komla-<version>-<arch>-setup.exe file name release.sh uploads.
  STAGING_ARGS+=(-c.extraMetadata.name=komla-staging "-c.nsis.artifactName=komla-\${version}-\${arch}-setup.\${ext}")
fi
npx electron-builder --win --config.npmRebuild=false --config.afterPack=./scripts/afterPack.cjs ${STAGING_ARGS[@]+"${STAGING_ARGS[@]}"}

echo "==> Windows build complete"
echo "==> Artifacts available in dist/"
