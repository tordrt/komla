#!/usr/bin/env bash
set -euo pipefail

bash scripts/link-deps.sh

# Type errors fail fast, before the suites start and add load.
npm run -s typecheck

# The Rust suite runs alongside vitest at a lower priority, so a cargo build
# can't slow vitest's timing-sensitive tests. Its output is held until the
# script exits, even on Ctrl-C, so the two reports don't interleave. On Windows
# a lower priority isn't enough: the Rust tests' git processes pushed vitest's
# git tests past their timeouts, so there the Rust suite runs after vitest,
# with its output shown as it runs. Without a Rust toolchain it is skipped with
# a warning.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) rust_after_vitest=1 ;;
  *) rust_after_vitest=0 ;;
esac
rust_log=$(mktemp)
trap 'cat "$rust_log"; rm -f "$rust_log"' EXIT
rust_pid=
if ! command -v cargo >/dev/null 2>&1; then
  echo 'Skipped the native Rust tests: cargo is not installed (https://rustup.rs).' >"$rust_log"
  rust_after_vitest=0
elif [ "$rust_after_vitest" -eq 0 ]; then
  nice -n 10 npm run test:native -- --quiet >"$rust_log" 2>&1 &
  rust_pid=$!
fi

vitest_status=0
npx vitest run "$@" || vitest_status=$?

rust_status=0
if [ -n "$rust_pid" ]; then
  wait "$rust_pid" || rust_status=$?
elif [ "$rust_after_vitest" -eq 1 ]; then
  npm run test:native -- --quiet || rust_status=$?
fi

if [ "$vitest_status" -ne 0 ]; then
  exit "$vitest_status"
fi
exit "$rust_status"
