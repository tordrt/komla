#!/bin/sh
# Antigravity CLI's weekly quota, for a status bar item: `status` for the bar, `popover` for its
# details. `agy -p /usage` prints a line per model group: name, limit, share left, refresh time.
usage=$(agy -p /usage 2>/dev/null) || exit 1
[ -n "$usage" ] || exit 1

# Seconds since the epoch for an ISO UTC time, with GNU date or BSD date.
epoch() { date -u -d "$1" +%s 2>/dev/null || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$1" +%s; }
# 2026-11-16T10:34:37Z → 4d 3h
until_reset() {
  secs=$(($(epoch "$1") - $(date +%s)))
  [ "$secs" -gt 0 ] || secs=0
  if [ "$secs" -ge 86400 ]; then echo "$((secs / 86400))d $((secs % 86400 / 3600))h"
  else echo "$((secs / 3600))h $((secs % 3600 / 60))m"; fi
}
# The group with the least left, which is the one that will stop you.
tone() { if [ "$1" -le 15 ]; then echo error; elif [ "$1" -le 40 ]; then echo warning; else echo success; fi; }

case $1 in
  status)
    low=$(echo "$usage" | awk -F'\t' '{ sub(/%/, "", $3); print $3 "\t" $1 }' | sort -n | head -1)
    left=${low%%	*}
    name=${low#*	}
    printf '{"segments": [{"text": "\\uf0e4", "color": "%s"}, {"text": " %s %s%% left"}]}\n' \
      "$(tone "$left")" "${name%% *}" "$left"
    ;;
  popover)
    style="<style>
      .group + .group { margin-top: 12px }
      .names { font-weight: 600 }
      .success .k-progress > span { background: var(--success) }
      .warning .k-progress > span { background: var(--warning) }
      .error .k-progress > span { background: var(--error) }
    </style>"
    page=""
    while IFS='	' read -r name _ share refresh; do
      left=${share%\%}
      page="$page<div class='group $(tone "$left")'>
        <div class='k-row'><span class='names k-grow'>$name</span>
          <span class='k-badge k-$(tone "$left")'>$share left</span></div>
        <div class='k-progress' style='margin:6px 0 4px;--value:$(awk -v n="$left" 'BEGIN { print n / 100 }')'><span></span></div>
        <div class='k-meta'><span>Weekly limit</span><span class='k-sep'></span><span>resets in $(until_reset "$refresh")</span></div>
      </div>"
    done <<END
$usage
END
    printf '{"html": "%s"}\n' "$(printf '%s' "$style$page" | tr -d '\n' | sed 's/"/\\"/g')"
    ;;
esac
