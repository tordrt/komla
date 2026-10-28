#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
target=${1:-}
if [ -z "$target" ]; then
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) target=x86_64-unknown-linux-musl ;;
    Linux:aarch64 | Linux:arm64) target=aarch64-unknown-linux-musl ;;
    Darwin:x86_64) target=x86_64-apple-darwin ;;
    Darwin:arm64) target=aarch64-apple-darwin ;;
    *) printf 'Unsupported build host; pass an explicit Rust target.\n' >&2; exit 1 ;;
  esac
fi

# Cargo writes host artifacts under target/release even with --target. Docker
# matrix builds can leave native/target owned by root, so fall back.
default_target_dir="$repo_root/native/target"
cargo_target_dir=${CARGO_TARGET_DIR:-$default_target_dir}
if ! mkdir -p "$cargo_target_dir" 2>/dev/null || [ ! -w "$cargo_target_dir" ]; then
  cargo_target_dir="${XDG_CACHE_HOME:-$HOME/.cache}/komla-native"
  mkdir -p "$cargo_target_dir"
  printf 'native/target is not writable; using %s\n' "$cargo_target_dir" >&2
fi
export CARGO_TARGET_DIR="$cargo_target_dir"

if [[ "$target" == *-windows-msvc ]]; then
  if ! cargo xwin --version >/dev/null 2>&1; then
    printf 'cargo-xwin 0.19.2 is required to build Windows Komla CLI artifacts. Install it with: cargo install cargo-xwin --version 0.19.2 --locked\n' >&2
    exit 1
  fi
  rustup target add "$target"
  cargo xwin build \
    --manifest-path "$repo_root/native/Cargo.toml" \
    --release \
    --locked \
    --target "$target"
else
  rustup target add "$target"
  cargo build \
    --manifest-path "$repo_root/native/Cargo.toml" \
    --release \
    --locked \
    --target "$target"
fi

destination="$repo_root/native/artifacts/$target"
# The installer copies the whole folder, so drop binaries an older build left.
rm -rf -- "$destination"
mkdir -p "$destination"
if [[ "$target" == *-windows-msvc ]]; then
  cp "$CARGO_TARGET_DIR/$target/release/komla.exe" "$destination/komla.exe"
else
  cp "$CARGO_TARGET_DIR/$target/release/komla" "$destination/komla"
  chmod 755 "$destination/komla"
  "$destination/komla" version
fi
