#!/bin/sh
# Prints the panel's page: Markdown of the local branches, newest first, and its buttons.
json() { awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, " "); print $0 "\\n" }'; }
current=$(git branch --show-current 2>/dev/null)
markdown=$(
  printf '**On %s**\n\n' "${current:-a detached HEAD}"
  printf '| Branch | Last commit |\n| --- | --- |\n'
  git for-each-ref --sort=-committerdate --count=30 refs/heads \
    --format='| `%(refname:short)`%(if)%(upstream:track)%(then) %(upstream:track)%(end) | %(committerdate:relative) |'
)
printf '{"markdown": "%s", "buttons": [{"label": "Fetch and prune", "run": "fetch"}, {"label": "Delete merged-away branches", "run": "gone"}]}\n' \
  "$(printf '%s' "$markdown" | json)"
