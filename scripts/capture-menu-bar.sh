#!/usr/bin/env bash
# Screenshots and records Komla's macOS menu bar item and its agents popover.
#
#   scripts/capture-menu-bar.sh [output-dir]
#
# Writes menu-bar-item.png, menu-bar.png, menu-bar-popover.png, menu-bar-popover-card.png and
# menu-bar.mov to the output dir (default e2e/videos/output/menu-bar). Needs macOS, Docker (the
# demo agents run on an SSH host, as in the landing videos), and, for the terminal running it,
# Screen Recording and Accessibility under System Settings > Privacy & Security. Leave the
# top-right of the screen clear while it runs: it records that corner. See
# e2e/videos/menu-bar.screenshot.ts.
set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "The menu bar item exists only on macOS." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
[ -n "${1:-}" ] && export KOMLA_MENU_BAR_OUT="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

npm run build
KOMLA_MENU_BAR_CAPTURE=1 npx playwright test --config e2e/playwright.config.ts \
  e2e/videos/menu-bar.screenshot.ts --reporter=line
echo "Done: ${KOMLA_MENU_BAR_OUT:-e2e/videos/output/menu-bar}"
