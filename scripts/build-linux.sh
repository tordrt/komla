#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-linux.sh — Build Linux binaries using Docker
#
# Usage:
#   bash scripts/build-linux.sh x64
#   bash scripts/build-linux.sh arm64
#
# Prerequisites:
#   - Docker Desktop installed and running
#   - For arm64 builds: QEMU emulation enabled (Docker Desktop does this automatically)
#   - App already built (npm run build) - uses existing out/ directory
# ---------------------------------------------------------------------------

ARCH="${1:-x64}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$PROJECT_ROOT/scripts/docker/linux.Dockerfile"
IMAGE_NAME="komla-builder-linux"
VOLUME_NAME="komla-linux-${ARCH}-node_modules"

case "$ARCH" in
  x64)
    PLATFORM="linux/amd64"
    ;;
  arm64)
    PLATFORM="linux/arm64"
    echo "Note: ARM64 builds use QEMU emulation and may take 10-30 minutes"
    ;;
  *)
    echo "error: invalid architecture '$ARCH' (expected x64 or arm64)" >&2
    exit 1
    ;;
esac

# Verify the app has been built
if [[ ! -d "$PROJECT_ROOT/out" ]]; then
  echo "error: out/ directory not found - run 'npm run build' first" >&2
  exit 1
fi

# Build Docker image for target platform if it doesn't exist. The tag includes
# the Dockerfile's hash so editing the Dockerfile builds a fresh image.
IMAGE_TAG="${IMAGE_NAME}:${ARCH}-$(git -C "$PROJECT_ROOT" hash-object "$DOCKERFILE" | cut -c1-12)"
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "==> Building Docker image $IMAGE_TAG..."
  docker build --platform "$PLATFORM" -t "$IMAGE_TAG" -f "$DOCKERFILE" "$PROJECT_ROOT/scripts/docker"
fi

# Ensure persistent Electron cache directory exists (survives reboots unlike /tmp)
mkdir -p "${HOME}/.cache/komla-release/electron"

echo "==> Building Linux $ARCH using Docker (platform: $PLATFORM)"

# Create named volume for node_modules if it doesn't exist
docker volume create "$VOLUME_NAME" >/dev/null 2>&1 || true

# Override linux.target to only build for the requested arch. Without this,
# electron-builder sees both arches in electron-builder.yml and tries to
# rebuild native modules for the other arch, which fails under QEMU (arm64
# g++ doesn't support -m64, and x64 g++ doesn't support arm64 flags).
# Note: yargs -c.key=value treats JSON as a string literal, so we generate
# a temp config file with the arch override instead.

docker run --rm \
  --platform "$PLATFORM" \
  -v "$PROJECT_ROOT":/project \
  -v "$VOLUME_NAME":/project/node_modules \
  -v "${HOME}/.cache/komla-release/electron":/tmp/electron-cache/electron \
  -e "electron_config_cache=/tmp/electron-cache/electron" \
  -e "XDG_CACHE_HOME=/tmp/electron-cache" \
  -w /project \
  "$IMAGE_TAG" \
  /bin/bash -c "
    set -euo pipefail

    echo '==> Installing npm packages...'
    # --no-save: the container's npm rewrites package-lock.json (dropping libc
    # fields), which dirties the tree and fails the next release's preflight.
    npm install --no-save

    echo '==> Generating single-arch config for $ARCH...'
    node -e \"
      const fs = require('fs');
      const yaml = require('js-yaml');
      const config = yaml.load(fs.readFileSync('electron-builder.yml', 'utf8'));
      config.linux.target = [{ target: 'AppImage', arch: ['$ARCH'] }];
      if (process.env.KOMLA_ENV === 'staging') {
        config.appId = 'com.komla.staging';
        config.productName = 'Komla Staging';
      }
      fs.writeFileSync('/tmp/eb-linux.json', JSON.stringify(config));
    \"

    echo '==> Running electron-builder for Linux $ARCH...'
    npx electron-builder --linux --config /tmp/eb-linux.json

    echo '==> Linux $ARCH build complete'
  "

echo "==> Linux $ARCH artifacts available in dist/"
