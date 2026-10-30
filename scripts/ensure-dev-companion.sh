#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
restore_only=false
if [ "${1:-}" = --restore-only ]; then restore_only=true; fi
host_os=${KOMLA_DEV_HOST_OS:-$(uname -s)}
host_arch=${KOMLA_DEV_HOST_ARCH:-$(uname -m)}
targets=(x86_64-unknown-linux-musl aarch64-unknown-linux-musl)

case "$host_os" in
  Darwin)
    targets+=(x86_64-apple-darwin aarch64-apple-darwin)
    ;;
  Linux)
    ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    case "$host_arch" in
      x86_64 | amd64) targets+=(x86_64-pc-windows-msvc) ;;
      aarch64 | arm64) targets+=(aarch64-pc-windows-msvc) ;;
      *)
        printf 'Unsupported Windows development architecture: %s\n' "$host_arch" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    printf 'Unsupported development host for Komla Companion artifacts: %s %s\n' \
      "$host_os" "$host_arch" >&2
    exit 1
    ;;
esac

if [ "${KOMLA_DEV_DRY_RUN:-0}" = 1 ]; then
  printf 'targets'
  printf ' %s' "${targets[@]}"
  printf '\n'
  exit 0
fi

# Build inputs are the files git sees under native, minus tests and
# build output, plus the outside files the build reads. Hidden files such as
# editor swap files and .DS_Store are skipped. The Local copy of an SSH
# Workspace has no .git, so there find lists every file; its sync already left
# out the files the SSH host's .gitignore ignores.
list_inputs() {
  local input
  {
    if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git -C "$repo_root" ls-files -co --exclude-standard -- native \
        ':(exclude)native/tests' ':(exclude)native/artifacts' \
        ':(exclude)native/target' src/shared/git-line-count-policy.json \
        scripts/ensure-dev-companion.sh
    else
      printf '%s\n' src/shared/git-line-count-policy.json scripts/ensure-dev-companion.sh
      (cd "$repo_root" && find native \( -path native/tests \
        -o -path native/artifacts -o -path native/target \) -prune \
        -o ! -type d -print)
    fi
  } | LC_ALL=C sort |
    while IFS= read -r input; do
      case "${input##*/}" in .*) continue ;; esac
      if [ -f "$repo_root/$input" ]; then printf '%s\n' "$input"; fi
    done
}

# git hash-object needs no repository.
source_key() {
  {
    printf '%s\n' "$1"
    printf '%s\n' "$1" | (cd "$repo_root" && git hash-object --no-filters --stdin-paths)
  } | git hash-object --stdin
}

dev_mark() {
  printf '%s/.dev-build' "$(dirname "$1")"
}

# A development artifact is current when its mark holds the key of the sources
# it was built from, so edits, deleted inputs and interrupted runs all make it
# out of date. Any other local artifact is kept when newer than every input, so
# a build made in this worktree for its current sources is never replaced from
# the cache.
artifact_is_current() {
  local artifact=$1 input
  [ -f "$artifact" ] || return 1
  if [ -f "$(dev_mark "$artifact")" ]; then
    [ "$(cat "$(dev_mark "$artifact")")" = "$key" ]
    return
  fi
  while IFS= read -r input; do
    if [ "$repo_root/$input" -nt "$artifact" ]; then return 1; fi
  done <<<"$inputs"
}

# Worktrees share builds through a cache keyed by the companion's build inputs,
# so a worktree only builds when no cached build matches its companion sources.
inputs=$(list_inputs)
key=$(source_key "$inputs")
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/komla-companion-artifacts"
cache_entry="$cache_root/$key"

executable_name() {
  if [[ "$1" == *-windows-msvc ]]; then printf 'komla.exe'; else printf 'komla'; fi
}

# Rename into place so a running binary is never overwritten.
install_file() {
  local source=$1 destination=$2
  mkdir -p "$(dirname "$destination")"
  cp "$source" "$destination.tmp.$$"
  chmod 755 "$destination.tmp.$$"
  mv -f "$destination.tmp.$$" "$destination"
}

# The mark makes packaging refuse this artifact (scripts/beforePack.cjs). A
# release build replaces the whole folder, which removes it. It starts empty so
# an interrupted install leaves an artifact that is marked and out of date.
install_dev_artifact() {
  mkdir -p "$(dirname "$2")"
  : >"$(dev_mark "$2")"
  install_file "$1" "$2"
  printf '%s\n' "$key" >"$(dev_mark "$2")"
}

# Builds for development skip the release profile's LTO. The companion has no C
# dependencies, so the toolchain's rust-lld links the Linux targets without
# Docker; releases still build through scripts/build-native-matrix.sh. Running
# from native/ selects its pinned toolchain. Every checkout keeps its own target
# directory, because Cargo trusts file times and paths relative to the workspace:
# a shared one can hand back another checkout's binary as up to date.
build_dev_artifact() {
  local target=$1 executable linker_variable
  executable=$(executable_name "$target")
  (
    cd "$repo_root/native"
    export CARGO_TARGET_DIR="$repo_root/native/target"
    rustup target add "$target"
    case "$target" in
      *-windows-msvc)
        if ! cargo xwin --version >/dev/null 2>&1; then
          printf 'cargo-xwin 0.19.2 is required to build Windows Komla CLI artifacts. Install it with: cargo install cargo-xwin --version 0.19.2 --locked\n' >&2
          exit 1
        fi
        cargo xwin build --profile companion-dev --locked --target "$target"
        ;;
      *-linux-musl)
        linker_variable=$(printf 'CARGO_TARGET_%s_LINKER' "$target" | tr 'a-z-' 'A-Z_')
        env "$linker_variable=rust-lld" cargo build --profile companion-dev --locked --target "$target"
        ;;
      *)
        cargo build --profile companion-dev --locked --target "$target"
        ;;
    esac
  )
  install_dev_artifact "$repo_root/native/target/$target/companion-dev/$executable" \
    "$repo_root/native/artifacts/$target/$executable"
}

restored_targets=()
uncached_targets=()
for target in "${targets[@]}"; do
  executable=$(executable_name "$target")
  cached="$cache_entry/$target/$executable"
  artifact="$repo_root/native/artifacts/$target/$executable"
  if artifact_is_current "$artifact"; then
    continue
  elif [ -f "$cached" ]; then
    install_dev_artifact "$cached" "$artifact"
    restored_targets+=("$target")
  else
    uncached_targets+=("$target")
  fi
done

if [ ${#restored_targets[@]} -gt 0 ]; then
  touch -c "$cache_entry"
  printf 'Restored Komla Companion artifacts from %s:' "$cache_entry"
  printf ' %s' "${restored_targets[@]}"
  printf '\n'
fi

if [ ${#uncached_targets[@]} -eq 0 ]; then
  printf 'Komla Companion artifacts are current.\n'
  exit 0
fi

if $restore_only; then
  printf 'Komla Companion artifacts are missing or out of date, and no cached build matches:'
  printf ' %s' "${uncached_targets[@]}"
  printf '\nRun npm run dev -- --companion to build them.\n'
  exit 0
fi

printf 'Building Komla Companion artifacts:'
printf ' %s' "${uncached_targets[@]}"
printf '\n'
for target in "${uncached_targets[@]}"; do
  build_dev_artifact "$target"
done

if [ "$(source_key "$(list_inputs)")" != "$key" ]; then
  printf 'Companion sources changed during the build, so these artifacts are out of date and not cached.\n'
  printf 'Run npm run dev -- --companion again to rebuild them.\n'
  exit 0
fi

# Every target, because an earlier failed run may have built some of them.
for target in "${targets[@]}"; do
  executable=$(executable_name "$target")
  artifact="$repo_root/native/artifacts/$target/$executable"
  if [ -f "$(dev_mark "$artifact")" ] && artifact_is_current "$artifact"; then
    install_file "$artifact" "$cache_entry/$target/$executable"
  fi
done

# Keep the ten most recently used builds. Entry names are hashes, so ls is safe.
# shellcheck disable=SC2012
ls -1t "$cache_root" | tail -n +11 | while IFS= read -r stale; do
  rm -rf "${cache_root:?}/$stale"
done || true
