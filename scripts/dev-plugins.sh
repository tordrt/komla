#!/usr/bin/env bash
# Copies the sample plugins, examples/plugins and examples/dev-plugins, into a development data
# folder's plugins folder: ~/.komla-dev (npm run dev's) unless another folder is given.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
data_dir=${1:-"$HOME/.komla-dev"}
plugins_dir="$data_dir/plugins"
mkdir -p "$plugins_dir"

for source in "$repo_root"/examples/plugins/*/ "$repo_root"/examples/dev-plugins/*/; do
  [ -f "$source/komla-plugin.json" ] || continue
  name=$(basename "$source")
  rm -rf -- "${plugins_dir:?}/$name"
  cp -R "$source" "$plugins_dir/$name"
  printf 'Copied %s\n' "$name"
done
printf 'Turn them on in Settings → Plugins (%s).\n' "$plugins_dir"
