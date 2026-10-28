#!/usr/bin/env bash
# Runs before every dev/test/build script so node_modules matches this
# worktree's package-lock.json and its workspace links point at this
# worktree's source. See scripts/worktree-deps.cjs.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/worktree-deps.cjs" link
