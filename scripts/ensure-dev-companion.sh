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
        scripts/build-native-matrix.sh
    else
      printf '%s\n' src/shared/git-line-count-policy.json scripts/build-native-matrix.sh
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

# A local artifact newer than every input is kept, so a build made in this
# worktree for its current sources is never replaced from the cache.
artifact_is_current() {
  local artifact=$1 input
  [ -f "$artifact" ] || return 1
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

restored_targets=()
uncached_targets=()
for target in "${targets[@]}"; do
  executable=$(executable_name "$target")
  cached="$cache_entry/$target/$executable"
  artifact="$repo_root/native/artifacts/$target/$executable"
  if artifact_is_current "$artifact"; then
    continue
  elif [ -f "$cached" ]; then
    install_file "$cached" "$artifact"
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

if printf '%s\n' "${uncached_targets[@]}" | grep -q -- '-unknown-linux-musl$'; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    printf 'Docker must be running to build Linux Komla Companion artifacts for SSH development.\n' >&2
    exit 1
  fi
fi

printf 'Building Komla Companion artifacts:'
printf ' %s' "${uncached_targets[@]}"
printf '\n'
bash "$repo_root/scripts/build-native-matrix.sh" "${uncached_targets[@]}"

if [ "$(source_key "$(list_inputs)")" != "$key" ]; then
  printf 'Companion sources changed during the build; not caching it.\n'
  exit 0
fi

for target in "${uncached_targets[@]}"; do
  executable=$(executable_name "$target")
  install_file "$repo_root/native/artifacts/$target/$executable" \
    "$cache_entry/$target/$executable"
done

# Keep the ten most recently used builds. Entry names are hashes, so ls is safe.
# shellcheck disable=SC2012
ls -1t "$cache_root" | tail -n +11 | while IFS= read -r stale; do
  rm -rf "${cache_root:?}/$stale"
done || true
