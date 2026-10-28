#!/usr/bin/env bash
set -euo pipefail

operating_system=${1:-$(uname -s)}
architecture=${2:-$(uname -m)}

case "${operating_system}:${architecture}" in
  Linux:x86_64 | Linux:amd64) printf '%s\n' x86_64-unknown-linux-musl ;;
  Linux:aarch64 | Linux:arm64) printf '%s\n' aarch64-unknown-linux-musl ;;
  *)
    printf 'unsupported Remote Companion host: %s %s\n' "$operating_system" "$architecture" >&2
    exit 1
    ;;
esac
