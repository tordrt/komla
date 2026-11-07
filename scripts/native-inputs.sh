# shellcheck shell=bash
# Sourced by scripts/ensure-dev-companion.sh and scripts/test-native.sh: lists the
# files a native build or test run reads and hashes them into a key, so worktrees
# can share a result for the same native sources. Only the result is shared, never
# Cargo's target directory: Cargo trusts file times and paths relative to the
# workspace, so a shared one can hand one checkout another checkout's binary as up
# to date.

# native_inputs <repo root> build|test
#
# Prints the inputs, one path per line relative to the repo root: the files git
# sees under native, minus build output, plus the outside files the crate reads.
# A build leaves out native/tests, which only the tests compile. Hidden files such
# as editor swap files and .DS_Store are skipped. The Local copy of an SSH
# Workspace has no .git, so there find lists every file; its sync already left out
# the files the SSH host's .gitignore ignores. Git is asked only when the root has
# its own .git, since a repository around a Local copy, such as a home directory
# kept in git, may ignore or not track the copy's files.
native_inputs() {
  local root=$1 kind=$2 input skipped
  local outside=(src/shared/git-line-count-policy.json scripts/native-inputs.sh)
  local unbuilt=(native/artifacts native/target)
  case "$kind" in
    build)
      outside+=(scripts/ensure-dev-companion.sh)
      unbuilt+=(native/tests)
      ;;
    # The schedule tests read the cases Komla's TypeScript tests share.
    test) outside+=(src/shared/automation-schedule-cases.json scripts/test-native.sh) ;;
    *)
      printf 'native_inputs: unknown kind %s\n' "$kind" >&2
      return 1
      ;;
  esac
  local excludes=() prune=(-false)
  for skipped in "${unbuilt[@]}"; do
    excludes+=(":(exclude)$skipped")
    prune+=(-o -path "$skipped")
  done
  {
    if [ -e "$root/.git" ] && git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git -C "$root" ls-files -co --exclude-standard -- native "${excludes[@]}" "${outside[@]}"
    else
      printf '%s\n' "${outside[@]}"
      (cd "$root" && find native \( "${prune[@]}" \) -prune -o ! -type d -print)
    fi
  } | LC_ALL=C sort |
    while IFS= read -r input; do
      case "${input##*/}" in .*) continue ;; esac
      if [ -f "$root/$input" ]; then printf '%s\n' "$input"; fi
    done
}

# native_inputs_key <repo root> <inputs> [<extra>]
#
# Hashes the input paths, their contents and any extra text, such as a toolchain
# version. git hash-object needs no repository, but inside one it reads paths from
# the repository's top level, so they get the root's prefix there, such as for a
# Local copy inside a home directory kept in git.
native_inputs_key() {
  local root=$1 inputs=$2 prefix contents input
  prefix=$(cd "$root" && git rev-parse --show-prefix 2>/dev/null) || prefix=
  contents=$(
    while IFS= read -r input; do printf '%s%s\n' "$prefix" "$input"; done <<<"$inputs" |
      (cd "$root" && git hash-object --no-filters --stdin-paths)
  ) || return
  {
    printf '%s\n' "$inputs" "$contents"
    if [ -n "${3:-}" ]; then printf '%s\n' "$3"; fi
  } | git hash-object --stdin
}
