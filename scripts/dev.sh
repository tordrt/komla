#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
mode=${1:-default}
shift || true

export KOMLA_DIAGNOSTICS="${KOMLA_DIAGNOSTICS:-1}"

# Run from a Baton terminal, Baton's env would give Komla's terminals its pane
# ids, and its agent hooks would then report Komla's agents to it.
while IFS= read -r name; do unset "$name"; done < <(compgen -e | grep '^BATON_' || true)

build_companion=false
vite_args=()
vite_arg_count=0
for argument in "$@"; do
  case "$argument" in
    --companion) build_companion=true ;;
    *)
      vite_args+=("$argument")
      vite_arg_count=$((vite_arg_count + 1))
      ;;
  esac
done

fresh_data_dir=
case "$mode" in
  default)
    data_dir="$HOME/.komla-dev"
    ;;
  sandbox)
    data_dir=/tmp/komla-dev
    ;;
  sandbox-clean)
    data_dir=/tmp/komla-dev
    if [ "${KOMLA_DEV_DRY_RUN:-0}" != 1 ]; then rm -rf -- /tmp/komla-dev; fi
    ;;
  sandbox-fresh)
    fresh_data_root=${TMPDIR:-/tmp}
    if [ "${KOMLA_DEV_DRY_RUN:-0}" = 1 ]; then
      data_dir="${fresh_data_root%/}/komla-dev-fresh.DRY_RUN"
    else
      fresh_data_dir=$(mktemp -d "${fresh_data_root%/}/komla-dev-fresh.XXXXXX")
      data_dir=$fresh_data_dir
      cleanup() {
        case "$fresh_data_dir" in
          "${fresh_data_root%/}"/komla-dev-fresh.*) rm -rf -- "$fresh_data_dir" ;;
          *) printf 'Refusing to clean unexpected fresh sandbox path: %s\n' "$fresh_data_dir" >&2 ;;
        esac
      }
      trap cleanup EXIT
    fi
    ;;
  *)
    printf 'Unknown Komla development mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac

if $build_companion; then
  if [ "${KOMLA_DEV_DRY_RUN:-0}" = 1 ]; then
    printf 'prepare companion\n'
  else
    bash "$repo_root/scripts/ensure-dev-companion.sh"
  fi
elif [ "${KOMLA_DEV_DRY_RUN:-0}" = 1 ]; then
  printf 'restore companion\n'
else
  bash "$repo_root/scripts/ensure-dev-companion.sh" --restore-only ||
    printf 'Could not restore cached Komla Companion artifacts; continuing.\n' >&2
fi

if [ "${KOMLA_DEV_DRY_RUN:-0}" = 1 ]; then
  printf 'prepare dependencies\n'
  printf 'launch KOMLA_DATA_DIR=%s KOMLA_DIAGNOSTICS=%s electron-vite dev' "$data_dir" "$KOMLA_DIAGNOSTICS"
  if [ "$vite_arg_count" -gt 0 ]; then
    for argument in "${vite_args[@]}"; do printf ' %s' "$argument"; done
  fi
  printf '\n'
  exit 0
fi

cd "$repo_root"
bash scripts/link-deps.sh
npm --workspace komla-remote-web run build:web
printf 'Starting Komla with development data at %s\n' "$data_dir"

if [ "$vite_arg_count" -gt 0 ] && [ -n "$fresh_data_dir" ]; then
  KOMLA_DATA_DIR="$data_dir" electron-vite dev "${vite_args[@]}"
elif [ "$vite_arg_count" -gt 0 ]; then
  exec env KOMLA_DATA_DIR="$data_dir" electron-vite dev "${vite_args[@]}"
elif [ -n "$fresh_data_dir" ]; then
  KOMLA_DATA_DIR="$data_dir" electron-vite dev
else
  exec env KOMLA_DATA_DIR="$data_dir" electron-vite dev
fi
