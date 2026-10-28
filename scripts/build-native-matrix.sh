#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
manifest="$repo_root/native/Cargo.toml"
artifacts="$repo_root/native/artifacts"
mkdir -p "$artifacts"

requested_targets=("$@")
should_build_target() {
  local target=$1
  if [ ${#requested_targets[@]} -eq 0 ]; then return 0; fi
  local requested
  for requested in "${requested_targets[@]}"; do
    if [ "$requested" = "$target" ]; then return 0; fi
  done
  return 1
}

build_linux() {
  local platform=$1 target=$2 output_dir=$3
  mkdir -p "$repo_root/native/target"
  docker run --rm --platform "$platform" \
    -e CARGO_HOME=/tmp/cargo \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    -e CARGO_TARGET_DIR="/work/native/target/$output_dir" \
    -v "$repo_root:/work" \
    -w /work/native \
    rust:1.88-alpine \
    sh -c 'chown -R "$HOST_UID:$HOST_GID" /work/native/target && apk add --no-cache musl-dev >/dev/null && cargo build --release --locked && chown -R "$HOST_UID:$HOST_GID" "$CARGO_TARGET_DIR"'
  rm -rf -- "$artifacts/$target"
  mkdir -p "$artifacts/$target"
  cp "$repo_root/native/target/$output_dir/release/komla" \
    "$artifacts/$target/komla"
  chmod 755 "$artifacts/$target/komla"
}

if should_build_target x86_64-unknown-linux-musl; then
  build_linux linux/amd64 x86_64-unknown-linux-musl linux-x64
fi
if should_build_target aarch64-unknown-linux-musl; then
  build_linux linux/arm64 aarch64-unknown-linux-musl linux-arm64
fi

if { should_build_target x86_64-apple-darwin || should_build_target aarch64-apple-darwin; } &&
  [ "$(uname -s)" != Darwin ]; then
  printf 'macOS is required to build the Darwin remote companion artifacts.\n' >&2
  exit 1
fi

for target in x86_64-apple-darwin aarch64-apple-darwin; do
  should_build_target "$target" || continue
  rustup target add "$target"
  cargo build --manifest-path "$manifest" --release --locked --target "$target"
  rm -rf -- "$artifacts/$target"
  mkdir -p "$artifacts/$target"
  cp "$repo_root/native/target/$target/release/komla" \
    "$artifacts/$target/komla"
  chmod 755 "$artifacts/$target/komla"
done

build_windows() {
  local target=$1
  if ! cargo xwin --version >/dev/null 2>&1; then
    printf 'cargo-xwin 0.19.2 is required to build Windows Komla CLI artifacts. Install it with: cargo install cargo-xwin --version 0.19.2 --locked\n' >&2
    exit 1
  fi
  rustup target add "$target"
  cargo xwin build --manifest-path "$manifest" --release --locked --target "$target"
  rm -rf -- "$artifacts/$target"
  mkdir -p "$artifacts/$target"
  cp "$repo_root/native/target/$target/release/komla.exe" \
    "$artifacts/$target/komla.exe"
}

for target in x86_64-pc-windows-msvc aarch64-pc-windows-msvc; do
  should_build_target "$target" || continue
  build_windows "$target"
done

for binary in "$artifacts"/*/komla; do
  [ -f "$binary" ] || continue
  "$binary" version || true
done
