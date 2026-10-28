#!/usr/bin/env bash
# Run Komla's dev build on a virtual X desktop viewed over VNC, for testing on a headless
# Linux host. See docs/LINUX-TESTING.md.
#
#   linux-desktop.sh start              start the display (VNC on localhost only) and openbox,
#                                       or use an X server already on the display
#   linux-desktop.sh komla [mode] [...] run `scripts/dev.sh <mode> [...]` on the display (mode: default)
#   linux-desktop.sh stop-komla         stop the Komla dev build
#   linux-desktop.sh stop               stop Komla, openbox and the display
#   linux-desktop.sh status             show what is running and the VNC password
#   linux-desktop.sh screenshot [out]   save the display as a PNG, read over VNC
#
# Environment: DESKTOP_DISPLAY (default :1), DESKTOP_GEOMETRY (default 1600x1000),
# KOMLA_CHECKOUT (default: the checkout containing this script).
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
checkout=${KOMLA_CHECKOUT:-$repo_root}
display=${DESKTOP_DISPLAY:-:1}
port=$((5900 + ${display#:}))
geometry=${DESKTOP_GEOMETRY:-1600x1000}
state=${XDG_STATE_HOME:-$HOME/.local/state}/komla-linux-desktop/${display#:}
mkdir -p "$state/logs" "$state/run"

uid=$(id -u)
user=$(id -un)
clean_path="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
# What a desktop session hands an app. Launched from a Komla terminal, the inherited
# KOMLA_* variables would point the test instance's terminals at that other Komla.
clean_env=(env -i
  HOME="$HOME" USER="$user" LOGNAME="$user" SHELL="${SHELL:-/bin/bash}"
  LANG="${LANG:-en_US.UTF-8}"
  PATH="$clean_path"
  XDG_RUNTIME_DIR="/run/user/$uid"
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus"
  XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=openbox
  DISPLAY="$display")

proc_start() { ps -o lstart= -p "$1" 2>/dev/null | awk '{$1 = $1; print}'; }
pid_of() { local pid _start; read -r pid _start 2>/dev/null <"$state/run/$1.pid" && echo "$pid"; }
# A pid file holds the pid and its start time, so a pid reused after a reboot or crash
# doesn't pass for the process that wrote it.
alive() {
  local pid started
  read -r pid started 2>/dev/null <"$state/run/$1.pid" || return 1
  [ -n "$started" ] && [ "$(proc_start "$pid")" = "$started" ]
}

# Whoever started it, the X server holding the display is the live pid in its lock file.
x_lock=/tmp/.X${display#:}-lock
x_socket=/tmp/.X11-unix/X${display#:}
x_server_pid() {
  local pid
  [ -r "$x_lock" ] || return 1
  pid=$(tr -d ' \n' <"$x_lock")
  [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1 && echo "$pid"
}
x_server_mine() { [ "$(ps -o uid= -p "$1" | awk '{print $1}')" = "$uid" ]; }
foreign_x_server() { ! alive xvnc && x_server_pid >/dev/null; }

# Starts a command in its own session so it outlives this shell and stops as a group.
launch() { # name, command...
  local name=$1 pid
  shift
  rm -f "$state/run/$name.pid"
  setsid -f bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$state/run/$name.pid" "$@" \
    >"$state/logs/$name.log" 2>&1 </dev/null
  for _ in $(seq 50); do [ -s "$state/run/$name.pid" ] && break; sleep 0.1; done
  pid=$(pid_of "$name") && echo "$pid $(proc_start "$pid")" >"$state/run/$name.pid"
}

# SIGINT, as Ctrl+C in a terminal would send to the group. Waits for the whole group: the
# leader can exit while its children, such as Electron, are still shutting down.
stop_one() { # name
  local name=$1 group
  if alive "$name"; then
    group=-$(pid_of "$name")
    kill -INT -- "$group" 2>/dev/null || true
    for _ in $(seq 100); do kill -0 -- "$group" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "$group" 2>/dev/null || true
  fi
  rm -f "$state/run/$name.pid"
}

ensure_password() {
  [ -s "$state/vnc-password" ] && [ -s "$state/vnc-passwd.bin" ] && return
  umask 077
  printf '%s' "$(openssl rand -hex 4)" >"$state/vnc-password" # exactly 8 chars, VNC's max
  # A VNC password file is the 8-byte password DES-encrypted with VNC's fixed key.
  openssl enc -des-ecb -nopad -nosalt -K e84ad660c4721ae0 \
    -provider legacy -provider default <"$state/vnc-password" >"$state/vnc-passwd.bin"
}

show_status() {
  local name status pid
  for name in xvnc openbox komla; do
    if alive "$name"; then
      status="running (pid $(pid_of "$name"))"
    elif [ "$name" = xvnc ] && pid=$(x_server_pid); then
      status="started elsewhere (pid $pid, $(ps -o comm= -p "$pid")); stop leaves it running"
    else
      status=stopped
    fi
    printf '%-8s %s\n' "$name" "$status"
  done
  if foreign_x_server; then
    echo "display $display: its VNC port and password are whatever started it set"
  else
    echo "display $display, VNC 127.0.0.1:$port, password: $(cat "$state/vnc-password" 2>/dev/null)"
  fi
  echo "logs: $state/logs"
}

case "${1:-}" in
  start)
    for tool in Xvnc openbox openssl; do
      command -v "$tool" >/dev/null ||
        { echo "$tool not found; run: sudo apt install -y tigervnc-standalone-server openbox" >&2; exit 1; }
    done
    ensure_password
    if foreign_x_server; then
      pid=$(x_server_pid)
      x_server_mine "$pid" ||
        { echo "display $display belongs to another user (pid $pid); choose a free one with DESKTOP_DISPLAY" >&2; exit 1; }
      echo "display $display is already served by pid $pid; using it"
    elif ! alive xvnc; then
      # A crashed X server leaves its lock behind, and Xvnc refuses the display until it's gone.
      if [ -e "$x_lock" ]; then
        echo "removing the stale X lock for $display"
        rm -f "$x_lock" "$x_socket" || true
      fi
      launch xvnc Xvnc "$display" -localhost -rfbport "$port" \
        -SecurityTypes VncAuth -rfbauth "$state/vnc-passwd.bin" \
        -geometry "$geometry" -depth 24 -nolisten tcp -AlwaysShared \
        -desktop "Komla Linux test"
      for _ in $(seq 50); do [ -S "$x_socket" ] && break; sleep 0.1; done
      alive xvnc || { tail -5 "$state/logs/xvnc.log" >&2; exit 1; }
    fi
    alive openbox || launch openbox "${clean_env[@]}" openbox
    show_status
    ;;
  komla)
    shift
    [ $# -gt 0 ] || set -- default
    if ! alive xvnc; then
      pid=$(x_server_pid) && x_server_mine "$pid" ||
        { echo "display $display is not running; run: $0 start" >&2; exit 1; }
    fi
    alive komla && { echo "Komla is already running on $display; run: $0 stop-komla" >&2; exit 1; }
    # PATH as `npm run` would set it, so dev.sh finds electron-vite.
    launch komla "${clean_env[@]}" PATH="$checkout/node_modules/.bin:$clean_path" \
      bash "$checkout/scripts/dev.sh" "$@"
    echo "Komla dev build starting from $checkout (log: $state/logs/komla.log)"
    ;;
  stop-komla)
    stop_one komla
    ;;
  stop)
    stop_one komla
    stop_one openbox
    stop_one xvnc
    ;;
  status)
    show_status
    ;;
  screenshot)
    foreign_x_server &&
      { echo "display $display wasn't started by this script, so its VNC password is unknown" >&2; exit 1; }
    node "$repo_root/scripts/vnc-screenshot.mjs" "$port" "$state/vnc-password" "${2:-$state/screenshot.png}"
    ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
