#!/usr/bin/env bash
# Runs the studio service in the background, detached from the terminal, so it
# keeps running after the SSH session ends.
#
#   scripts/studio-server.sh [start]   build if needed and start; does nothing if it is already running
#   scripts/studio-server.sh stop      stop it (Ctrl-C first, harder only if it does not exit)
#   scripts/studio-server.sh restart   stop, rebuild, start
#   scripts/studio-server.sh status    running or not, and where
#   scripts/studio-server.sh logs      follow the log
#
# Settings (environment variables, all optional):
#   YUE_ENGINE_ROOT   engine bundle         default: ~/yue2-engine
#   YUE_STUDIO_PORT   service port          default: 8791
#   STUDIO_STATE_DIR  pid and log files     default: ~/.local/state/yue2-studio
#   STUDIO_NO_SLEEP   1 keeps a Mac awake while the service runs (caffeinate)  default: 1
#
# Written for the bash 3.2 that ships with macOS; works on Linux too.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export YUE_ENGINE_ROOT="${YUE_ENGINE_ROOT:-$HOME/yue2-engine}"
PORT="${YUE_STUDIO_PORT:-8791}"
STATE="${STUDIO_STATE_DIR:-$HOME/.local/state/yue2-studio}"
PIDFILE="$STATE/music-server.pid"
LOG="$STATE/music-server.log"
BIN="${CARGO_TARGET_DIR:-$REPO/target}/debug/music-server"
HEALTH="http://127.0.0.1:$PORT/health"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The pid of the service this script started, if it is still that process.
running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) rm -f "$PIDFILE"; return 1 ;; esac
  if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q 'music-server'; then
    printf '%s\n' "$pid"
    return 0
  fi
  rm -f "$PIDFILE"   # left by a run that ended
  return 1
}

# Whether a studio service answers on the port (one started some other way counts too).
studio_answers() {
  local body
  body="$(curl -fsS --max-time 2 "$HEALTH" 2>/dev/null)" || return 1
  case "$body" in *'"music_engine"'*) return 0 ;; *) return 1 ;; esac
}

port_taken() {
  curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null
}

where() {
  say "  log:      $LOG"
  say "  this computer: http://127.0.0.1:$PORT/"
  say "  network:  http://<this-computer's-address>:$PORT/  (when access from the network is on)"
}

build() {
  say "building the service (nothing happens if it is up to date)..."
  (cd "$REPO" && cargo build -p music-server --bin music-server) || fail "the build failed"
  [ -x "$BIN" ] || fail "no service binary at $BIN after the build"

  # The interface the service hands browsers; rebuilt only when its sources changed.
  local dist="$REPO/app/dist/index.html"
  if ! command -v npm >/dev/null 2>&1; then
    say "npm not found: the service starts without its web interface (the API still works)"
    return 0
  fi
  if [ ! -d "$REPO/app/node_modules" ]; then
    say "installing the interface's packages..."
    npm --prefix "$REPO/app" ci --no-audit --no-fund >/dev/null || fail "npm ci failed"
  fi
  if [ ! -f "$dist" ] || [ -n "$(find "$REPO/app" "$REPO/desktop/src-tauri/tauri.conf.json" -newer "$dist" \
        -not -path "$REPO/app/node_modules/*" -not -path "$REPO/app/dist/*" -not -path "$REPO/app/data/changelog.json" \
        -type f -print -quit 2>/dev/null)" ]; then
    say "building the interface..."
    npm --prefix "$REPO/app" run build >/dev/null || fail "the interface build failed (run: npm --prefix app run build)"
  fi
}

start() {
  local pid
  if pid="$(running_pid)"; then
    say "already running (pid $pid)"; where; return 0
  fi
  if studio_answers; then
    say "a studio service already answers on port $PORT (not started by this script); leaving it alone"
    return 0
  fi
  port_taken && fail "port $PORT is used by another program; set YUE_STUDIO_PORT to another port"

  build
  mkdir -p "$STATE"
  # keep the log from growing without end: the previous one is kept as .1
  if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" | tr -d ' ')" -gt 20000000 ]; then mv -f "$LOG" "$LOG.1"; fi
  printf '\n=== started %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$LOG"

  # nohup: the end of the SSH session does not stop it. stdin is not a
  # terminal, so the service makes its own process group for its engines.
  (
    cd "$REPO" || exit 1
    nohup "$BIN" </dev/null >>"$LOG" 2>&1 &
    printf '%s\n' "$!" >"$PIDFILE"
  )
  pid="$(cat "$PIDFILE")"

  # A Mac that goes to sleep stops answering; keep it awake while the service runs.
  if [ "${STUDIO_NO_SLEEP:-1}" = 1 ] && command -v caffeinate >/dev/null 2>&1; then
    nohup caffeinate -i -w "$pid" </dev/null >/dev/null 2>&1 &
  fi

  say "starting (pid $pid)..."
  local waited=0
  while [ "$waited" -lt 120 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE"
      say "it stopped while starting; the end of its log:"
      tail -n 25 "$LOG" >&2
      exit 1
    fi
    if studio_answers; then
      say "running (pid $pid)"; where; return 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  say "started (pid $pid) but not answering on port $PORT after 120 s; see the log"; where
}

stop() {
  local pid
  if ! pid="$(running_pid)"; then
    if studio_answers; then
      say "a studio service answers on port $PORT, but this script did not start it; stop it where it was started"
    else
      say "not running"
    fi
    return 0
  fi
  say "stopping (pid $pid)..."
  # Ctrl-C: the service stops its engines itself (open pages get a few seconds)
  kill -INT "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do sleep 1; waited=$((waited + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    say "still running after ${waited}s; terminating it"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 3
  fi
  # whatever is left of it and its engines (the service leads its own process group)
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  pkill -KILL -g "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  say "stopped"
}

status() {
  local pid
  if pid="$(running_pid)"; then
    if studio_answers; then say "running (pid $pid)"; else say "process $pid is up but not answering on port $PORT yet"; fi
    where
  elif studio_answers; then
    say "a studio service answers on port $PORT (not started by this script)"
  else
    say "not running"
    return 3
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) mkdir -p "$STATE"; touch "$LOG"; exec tail -n 50 -f "$LOG" ;;
  *) fail "usage: $0 [start|stop|restart|status|logs]" ;;
esac
