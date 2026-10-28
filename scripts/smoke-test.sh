#!/usr/bin/env bash
set -euo pipefail

# ─── ANSI Colors ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── State ───────────────────────────────────────────────────────────────────
DEV_PID=""
declare -a SECTION_NAMES=()
declare -a SECTION_PASS=()
declare -a SECTION_FAIL=()
declare -a SECTION_SKIP=()
declare -a SECTION_FAIL_NOTES=()
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
CRITICAL_ONLY=false
SANDBOX_DIR="/tmp/komla-dev"

# ─── Helpers ─────────────────────────────────────────────────────────────────

cleanup() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    echo ""
    read -rp "$(echo -e "${YELLOW}Kill dev process (PID $DEV_PID)? [Y/n] ${RESET}")" kill_answer
    if [[ "${kill_answer,,}" != "n" ]]; then
      kill "$DEV_PID" 2>/dev/null && wait "$DEV_PID" 2>/dev/null || true
      echo -e "${GREEN}Dev process stopped.${RESET}"
    else
      echo -e "${DIM}Leaving dev process running (PID $DEV_PID).${RESET}"
    fi
  fi
}
trap cleanup EXIT

print_header() {
  local num="$1" title="$2"
  echo ""
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${CYAN}${BOLD}  $num. $title${RESET}"
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

# Ask for p/f/s and record result. Updates current section counters.
run_step() {
  local description="$1"
  echo ""
  echo -e "  ${BOLD}$description${RESET}"
  while true; do
    echo -en "  ${DIM}[p]ass / [f]ail / [s]kip: ${RESET}"
    read -rsn1 key
    case "$key" in
      p|P)
        echo -e "${GREEN}PASS${RESET}"
        (( current_pass++ )) || true
        (( TOTAL_PASS++ )) || true
        return
        ;;
      f|F)
        echo -e "${RED}FAIL${RESET}"
        local note=""
        read -rp "  Note (optional, Enter to skip): " note
        if [[ -n "$note" ]]; then
          SECTION_FAIL_NOTES+=("$description: $note")
        fi
        (( current_fail++ )) || true
        (( TOTAL_FAIL++ )) || true
        return
        ;;
      s|S)
        echo -e "${YELLOW}SKIP${RESET}"
        (( current_skip++ )) || true
        (( TOTAL_SKIP++ )) || true
        return
        ;;
      *)
        echo ""
        ;;
    esac
  done
}

begin_section() {
  local num="$1" title="$2"
  print_header "$num" "$title"
  SECTION_NAMES+=("$title")
  current_pass=0
  current_fail=0
  current_skip=0
}

end_section() {
  SECTION_PASS+=("$current_pass")
  SECTION_FAIL+=("$current_fail")
  SECTION_SKIP+=("$current_skip")
}

should_run_section() {
  local num="$1"
  if [[ "$CRITICAL_ONLY" == "true" ]]; then
    # Critical sections: 1 (Launch), 2 (Workspace Creation), 8 (Multi-Window), 9 (Lifecycle), 11 (License Limit)
    case "$num" in
      1|2|8|9|11) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

wait_for_app_ready() {
  local port_file="$SANDBOX_DIR/port"
  local timeout=15
  local elapsed=0

  echo -e "  ${DIM}Waiting for app to be ready (polling port file)...${RESET}"
  while [[ $elapsed -lt $timeout ]]; do
    if [[ -f "$port_file" ]]; then
      local port
      port=$(cat "$port_file")
      if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
        echo -e "  ${GREEN}App ready on port $port${RESET}"
        return 0
      fi
    fi
    sleep 1
    (( elapsed++ ))
  done

  echo -e "  ${YELLOW}Health check timed out after ${timeout}s${RESET}"
  read -rp "$(echo -e "${BOLD}Press Enter when the app window is visible. ${RESET}")"
}

print_summary() {
  echo ""
  echo ""
  echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${CYAN}${BOLD}║                       SMOKE TEST RESULTS                        ║${RESET}"
  echo -e "${CYAN}${BOLD}╠══════════════════════════════════════╦════════╦════════╦════════╣${RESET}"
  printf  "${CYAN}${BOLD}║${RESET} %-36s ${CYAN}${BOLD}║${RESET} ${GREEN}%-6s${RESET} ${CYAN}${BOLD}║${RESET} ${RED}%-6s${RESET} ${CYAN}${BOLD}║${RESET} ${YELLOW}%-6s${RESET} ${CYAN}${BOLD}║${RESET}\n" \
    "Section" "Pass" "Fail" "Skip"
  echo -e "${CYAN}${BOLD}╠══════════════════════════════════════╬════════╬════════╬════════╣${RESET}"

  for i in "${!SECTION_NAMES[@]}"; do
    local name="${SECTION_NAMES[$i]}"
    local p="${SECTION_PASS[$i]}"
    local f="${SECTION_FAIL[$i]}"
    local s="${SECTION_SKIP[$i]}"
    # Color the fail count red if > 0
    local f_color="${RESET}"
    if (( f > 0 )); then f_color="${RED}"; fi
    printf "${CYAN}${BOLD}║${RESET} %-36s ${CYAN}${BOLD}║${RESET} ${GREEN}%-6s${RESET} ${CYAN}${BOLD}║${RESET} ${f_color}%-6s${RESET} ${CYAN}${BOLD}║${RESET} ${YELLOW}%-6s${RESET} ${CYAN}${BOLD}║${RESET}\n" \
      "$name" "$p" "$f" "$s"
  done

  echo -e "${CYAN}${BOLD}╠══════════════════════════════════════╬════════╬════════╬════════╣${RESET}"
  local total_color="${GREEN}"
  if (( TOTAL_FAIL > 0 )); then total_color="${RED}"; fi
  printf "${CYAN}${BOLD}║${RESET} ${BOLD}%-36s${RESET} ${CYAN}${BOLD}║${RESET} ${GREEN}${BOLD}%-6s${RESET} ${CYAN}${BOLD}║${RESET} ${total_color}${BOLD}%-6s${RESET} ${CYAN}${BOLD}║${RESET} ${YELLOW}${BOLD}%-6s${RESET} ${CYAN}${BOLD}║${RESET}\n" \
    "TOTAL" "$TOTAL_PASS" "$TOTAL_FAIL" "$TOTAL_SKIP"
  echo -e "${CYAN}${BOLD}╚══════════════════════════════════════╩════════╩════════╩════════╝${RESET}"

  local total=$(( TOTAL_PASS + TOTAL_FAIL + TOTAL_SKIP ))
  echo ""
  if (( TOTAL_FAIL == 0 )); then
    echo -e "  ${GREEN}${BOLD}All $total tests passed or skipped!${RESET}"
  else
    echo -e "  ${RED}${BOLD}$TOTAL_FAIL of $total tests failed.${RESET}"
  fi

  if [[ ${#SECTION_FAIL_NOTES[@]} -gt 0 ]]; then
    echo -e "  ${RED}${BOLD}Failure Notes:${RESET}"
    for note in "${SECTION_FAIL_NOTES[@]}"; do
      echo -e "    ${RED}-${RESET} $note"
    done
    echo ""
  fi
  echo ""
}

# ─── Args ────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --critical) CRITICAL_ONLY=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ─── Main ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}  ╔══════════════════════════════════════╗${RESET}"
echo -e "${CYAN}${BOLD}  ║       Komla Smoke Test Runner        ║${RESET}"
echo -e "${CYAN}${BOLD}  ╚══════════════════════════════════════╝${RESET}"
echo ""

# ─── Setup ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}Setting up...${RESET}"
echo -e "  Cleaning /tmp/komla-dev..."
rm -rf /tmp/komla-dev

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo -e "  Starting ${BOLD}npm run dev:sandbox${RESET} in background..."
cd "$REPO_ROOT"
KOMLA_DATA_DIR=/tmp/komla-dev npx electron-vite dev > /tmp/komla-smoke-test.log 2>&1 &
DEV_PID=$!
echo -e "  Dev process PID: ${BOLD}$DEV_PID${RESET}"
echo -e "  ${DIM}Log output: /tmp/komla-smoke-test.log${RESET}"
echo ""
wait_for_app_ready

# ─── 1. App Launch & Setup Wizard ────────────────────────────────────────────
if should_run_section 1; then
  begin_section 1 "App Launch & Setup Wizard"
  run_step "App window opens without errors"
  run_step "Setup wizard appears on first launch (fresh sandbox)"
  run_step "Can select an agent preset"
  run_step "Can configure a project repository"
  run_step "Wizard completes and main UI loads"
  end_section
fi

# ─── 2. Workspace Creation ──────────────────────────────────────────────────
if should_run_section 2; then
  begin_section 2 "Workspace Creation"
  run_step "Create a worktree workspace from a project"
  run_step "Workspace appears in sidebar with correct name"
  run_step "Terminal spawns and agent command runs"
  run_step "Create a directory workspace (pick any folder)"
  run_step "Directory workspace appears and terminal runs"
  end_section
fi

# ─── 3. Terminal & Tabs ─────────────────────────────────────────────────────
if should_run_section 3; then
  begin_section 3 "Terminal & Tabs"
  run_step "Add a new terminal tab"
  run_step "Tab appears in tab bar"
  run_step "Split a tab into horizontal panes"
  run_step "Split a tab into vertical panes"
  run_step "Rename a tab via double-click"
  run_step "Close a tab"
  run_step "Drag-and-drop reorder tabs"
  run_step "Right-click context menu on tab"
  end_section
fi

# ─── 4. Terminal I/O ────────────────────────────────────────────────────────
if should_run_section 4; then
  begin_section 4 "Terminal I/O"
  run_step "Type a command in the terminal and see output"
  run_step "Terminal resize works (drag pane border)"
  run_step "Stop a terminal"
  run_step "Restart a terminal (continue command if agent)"
  end_section
fi

# ─── 5. Git Integration ─────────────────────────────────────────────────────
if should_run_section 5; then
  begin_section 5 "Git Integration"
  run_step "Open diff viewer for a worktree workspace"
  run_step "File sidebar shows changed files"
  run_step "Split/unified diff mode toggle works"
  run_step "Stage and unstage a file"
  run_step "Git status badge in sidebar updates"
  end_section
fi

# ─── 6. File Explorer ───────────────────────────────────────────────────────
if should_run_section 6; then
  begin_section 6 "File Explorer"
  run_step "Open file explorer for a workspace"
  run_step "File tree loads with correct structure"
  run_step "Search for a file using fuzzy search"
  run_step "Open a file in the editor"
  run_step "Edit and save a file"
  end_section
fi

# ─── 7. Settings ────────────────────────────────────────────────────────────
if should_run_section 7; then
  begin_section 7 "Settings"
  run_step "Open settings dialog"
  run_step "Change terminal font size"
  run_step "Switch agent preset"
  run_step "Close settings, verify changes applied"
  end_section
fi

# ─── 8. Multi-Window ────────────────────────────────────────────────────────
if should_run_section 8; then
  begin_section 8 "Multi-Window"
  run_step "Create a second window"
  run_step "Move a workspace to the second window"
  run_step "Workspace renders correctly in new window"
  run_step "Close the second window"
  end_section
fi

# ─── 9. Workspace Lifecycle ─────────────────────────────────────────────────
if should_run_section 9; then
  begin_section 9 "Workspace Lifecycle"
  run_step "Stop a workspace"
  run_step "Restart a workspace"
  run_step "Delete a workspace (confirm dialog)"
  run_step "Verify workspace removed from sidebar"
  end_section
fi

# ─── 10. Persistence ────────────────────────────────────────────────────────
if should_run_section 10; then
  begin_section 10 "Persistence"
  echo ""
  echo -e "  ${YELLOW}${BOLD}NOTE:${RESET} This section requires relaunching the app."
  echo -e "  ${DIM}The dev process will be restarted automatically.${RESET}"
  echo ""
  read -rp "$(echo -e "${BOLD}Press Enter to kill the app and relaunch...${RESET}")"

  if kill -0 "$DEV_PID" 2>/dev/null; then
    kill "$DEV_PID" 2>/dev/null && wait "$DEV_PID" 2>/dev/null || true
    echo -e "  ${DIM}App stopped.${RESET}"
  fi

  # Remove stale port file so we can detect the new process
  rm -f "$SANDBOX_DIR/port"

  echo -e "  Relaunching ${BOLD}npm run dev:sandbox${RESET} (keeping existing data)..."
  cd "$REPO_ROOT"
  KOMLA_DATA_DIR=/tmp/komla-dev npx electron-vite dev >> /tmp/komla-smoke-test.log 2>&1 &
  DEV_PID=$!
  echo -e "  Dev process PID: ${BOLD}$DEV_PID${RESET}"
  echo ""
  wait_for_app_ready

  run_step "Workspaces restored from previous session"
  run_step "Settings persisted (font size, agent preset)"
  end_section
fi

# ─── 11. License Limit UX ──────────────────────────────────────────────────
if should_run_section 11; then
  begin_section 11 "License Limit UX"
  run_step "Create workspaces up to free tier limit (4 total)"
  run_step "Attempt to create a 5th workspace"
  run_step "Upgrade dialog appears and blocks creation"
  end_section
fi

# ─── 12. MCP Server ────────────────────────────────────────────────────────
if should_run_section 12; then
  begin_section 12 "MCP Server"
  echo ""
  MCP_PORT_FILE="$SANDBOX_DIR/port"
  if [[ -f "$MCP_PORT_FILE" ]]; then
    MCP_PORT=$(cat "$MCP_PORT_FILE")
    echo -e "  ${DIM}Port file found: $MCP_PORT${RESET}"
    echo -e "  ${DIM}Running: curl -s localhost:$MCP_PORT/health${RESET}"
    MCP_HEALTH=$(curl -sf "http://localhost:$MCP_PORT/health" 2>/dev/null || echo "FAILED")
    echo -e "  ${DIM}Response: $MCP_HEALTH${RESET}"
    echo ""
  else
    echo -e "  ${YELLOW}Port file not found at $MCP_PORT_FILE — is the app running?${RESET}"
    echo ""
  fi
  run_step "Health endpoint responds with {\"ok\":true}"
  run_step "MCP server is accessible (verify in agent CLI or via curl)"
  end_section
fi

# ─── 13. Search ─────────────────────────────────────────────────────────────
if should_run_section 13; then
  begin_section 13 "Search"
  run_step "Open file search in a workspace"
  run_step "Search for a file by name — results appear"
  run_step "Search for content within files — results appear"
  end_section
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
print_summary
