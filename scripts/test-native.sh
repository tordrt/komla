#!/usr/bin/env bash
# The native Rust tests for npm test. They are skipped when a run for the same
# native sources and toolchain already passed in any worktree on this machine,
# so most branches, which never touch native/, don't compile the crate.
# KOMLA_FORCE_NATIVE_TESTS=1 runs them anyway; npm run test:native always does.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
# shellcheck source=scripts/native-inputs.sh
. "$repo_root/scripts/native-inputs.sh"

# Running from native/ selects its pinned toolchain. The verbose version names
# its host too. A missing toolchain leaves the key without a version, and cargo
# test then reports the problem.
toolchain() {
  (cd "$repo_root/native" && rustc -vV 2>/dev/null) || true
}

# Command substitutions don't inherit errexit, so a failed listing returns
# explicitly rather than hashing part of the inputs.
current_key() {
  local inputs
  inputs=$(native_inputs "$repo_root" test) || return
  native_inputs_key "$repo_root" "$inputs" "$(toolchain)"
}

key=$(current_key)
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/komla-native-tests"
marker="$cache_root/$key"

if [ "${KOMLA_FORCE_NATIVE_TESTS:-0}" != 1 ] && [ -f "$marker" ]; then
  touch -c "$marker"
  printf 'Skipped the native Rust tests: they passed for these native sources in %s (%s). Set KOMLA_FORCE_NATIVE_TESTS=1 to run them anyway.\n' \
    "$(head -n 1 "$marker")" "$marker"
  exit 0
fi

# A failure or an interrupted run exits here, before anything is recorded.
cargo test --manifest-path "$repo_root/native/Cargo.toml" --quiet

if ! after=$(current_key); then
  printf 'The native sources could not be listed again after the Rust tests ran, so this pass is not recorded.\n'
  exit 0
elif [ "$after" != "$key" ]; then
  printf 'Native sources changed while the Rust tests ran, so this pass is not recorded.\n'
  exit 0
fi

# Rename into place, since several worktrees can finish at once. The temporary
# file is hidden, so ls below never counts or prunes it, and removed if the
# script is stopped before the rename.
mkdir -p "$cache_root"
temporary="$cache_root/.$key.tmp.$$"
trap 'rm -f "$temporary"' EXIT
printf '%s\n' "$repo_root" >"$temporary"
mv -f "$temporary" "$marker"

# Keep the 200 most recently used passes. Entry names are hashes, so ls is safe.
# shellcheck disable=SC2012
ls -1t "$cache_root" | tail -n +201 | while IFS= read -r stale; do
  rm -f "${cache_root:?}/$stale"
done || true
