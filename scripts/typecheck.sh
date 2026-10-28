#!/usr/bin/env bash
set -euo pipefail

# The renderer and main/preload projects are independent, so check them side by side.
npx tsc --noEmit -p tsconfig.web.json &
web_pid=$!
npx tsc --noEmit -p tsconfig.node.json &
node_pid=$!

status=0
wait "$web_pid" || status=$?
wait "$node_pid" || status=$?
exit "$status"
