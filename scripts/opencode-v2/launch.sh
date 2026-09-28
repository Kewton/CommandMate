#!/usr/bin/env bash
#
# launch.sh — run an OpenCode V2 (`opencode2`) server and its TUI in ONE tmux
# pane, so the two live and die together (Issue #2934, Epic #2370 Phase 1).
#
# OpenCode 2's TUI does not host the API the way v1's does: the API is a
# separate `opencode2 serve`, and the TUI attaches to it with `--server`. If
# CommandMate started the server as a child of its own process, a CommandMate
# restart would take every agent's server down with it; if the server were
# started in the pane without a guard, closing the pane would leave the port
# bound (the #1905 failure, which v1 only avoided because its TUI WAS the
# server). So this wrapper owns both processes and a trap stops the server on
# every way out: the TUI exiting, `tmux kill-session` (SIGHUP), Ctrl-C (SIGINT)
# and SIGTERM.
#
# Usage:
#   launch.sh --port <N> --password-file <path> --directory <path>
#
# The password
#   CommandMate generates one per launch and writes it to a 0600 file under
#   ~/.commandmate/opencode-v2/. It is read here and placed in the environment
#   variable OPENCODE_SERVER_PASSWORD ONLY: it is never echoed, never passed as
#   an argument (argv is readable by `ps`), and the readiness probe hands it to
#   curl through `--config -` on stdin for the same reason. Accepted, and stated
#   so nobody has to rediscover it: the serve and TUI processes carry it in their
#   environment, and so does any shell tool the agent runs. The server listens on
#   127.0.0.1 only, so what the password protects stays inside the same OS user.
#
# Environment (tests only):
#   CM_OPENCODE_V2_READY_TIMEOUT   seconds to wait for the server (default 15)
#
# Exit codes: the TUI's own status when it exits; 64 usage error; 66 password
# file unreadable or empty; 69 the server did not answer in time; 129/130/143
# when stopped by SIGHUP / SIGINT / SIGTERM.
#
# Written for bash 3.2 (the macOS system bash): no associative arrays, no
# `mapfile`, no `${var^^}`, no `wait -n`.

set -u

PROGRAM_NAME="launch.sh"
READY_TIMEOUT_SECONDS="${CM_OPENCODE_V2_READY_TIMEOUT:-15}"
STOP_GRACE_TICKS=30 # x 0.1 s before SIGKILL

port=""
password_file=""
directory=""

usage() {
  echo "Usage: ${PROGRAM_NAME} --port <N> --password-file <path> --directory <path>" >&2
}

die() {
  local code="$1"
  shift
  echo "${PROGRAM_NAME}: $*" >&2
  exit "$code"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { usage; exit 64; }
      port="$2"
      shift 2
      ;;
    --password-file)
      [ $# -ge 2 ] || { usage; exit 64; }
      password_file="$2"
      shift 2
      ;;
    --directory)
      [ $# -ge 2 ] || { usage; exit 64; }
      directory="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die 64 "unknown argument: $1"
      ;;
  esac
done

if [ -z "$port" ] || [ -z "$password_file" ] || [ -z "$directory" ]; then
  usage
  exit 64
fi
case "$port" in
  '' | *[!0-9]*) die 64 "--port must be a number: ${port}" ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  die 64 "--port out of range: ${port}"
fi
case "$READY_TIMEOUT_SECONDS" in
  '' | *[!0-9]*) READY_TIMEOUT_SECONDS=15 ;;
esac
[ -d "$directory" ] || die 64 "--directory is not a directory: ${directory}"
[ -r "$password_file" ] || die 66 "password file is not readable: ${password_file}"

# `read` returns non-zero on a file without a trailing newline even though it
# filled the variable, so success is judged by the value, not the status.
OPENCODE_SERVER_PASSWORD=""
IFS= read -r OPENCODE_SERVER_PASSWORD <"$password_file" || true
[ -n "$OPENCODE_SERVER_PASSWORD" ] || die 66 "password file is empty: ${password_file}"
export OPENCODE_SERVER_PASSWORD

server_url="http://127.0.0.1:${port}"
serve_pid=""
tui_pid=""

# Stop one child: SIGTERM, a short grace period, then SIGKILL, then reap it so
# the port is released before this script's own exit is observable.
# shellcheck disable=SC2329 # invoked from the EXIT trap via cleanup
stop_child() {
  local pid="$1"
  local ticks=0
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge "$STOP_GRACE_TICKS" ]; then
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid" 2>/dev/null || true
}

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local tui="$tui_pid"
  local serve="$serve_pid"
  tui_pid=""
  serve_pid=""
  stop_child "$tui"
  stop_child "$serve"
}

trap cleanup EXIT
# Each signal becomes an ordinary exit, which runs the EXIT trap above exactly
# once. The TUI is waited on with `wait` (below) rather than run as a
# foreground command precisely so these fire immediately: bash defers a
# trapped signal until a foreground child returns, and a TUI that ignores the
# hangup would otherwise keep the server alive forever.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The server's own output would only be painted over by the TUI's alternate
# screen, and with OPENCODE_SERVER_PASSWORD set it prints no secret anyway.
opencode2 serve --hostname 127.0.0.1 --port "$port" </dev/null >/dev/null 2>&1 &
serve_pid=$!

# Ready means `GET /openapi.json` answered 200 with our credentials. The
# credentials go to curl on stdin (`--config -`), never on its command line.
probe_ready() {
  local code
  code="$(printf 'user = "opencode:%s"\n' "$OPENCODE_SERVER_PASSWORD" |
    curl --config - --silent --output /dev/null --write-out '%{http_code}' \
      --max-time 1 "${server_url}/openapi.json" 2>/dev/null)" || true
  [ "$code" = "200" ]
}

ready=0
deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$serve_pid" 2>/dev/null; then
    die 69 "opencode2 serve exited before answering on ${server_url}"
  fi
  if probe_ready; then
    ready=1
    break
  fi
  sleep 0.25
done
[ "$ready" -eq 1 ] || die 69 "opencode2 serve did not answer on ${server_url} within ${READY_TIMEOUT_SECONDS}s"

# Asynchronous commands in a non-interactive shell get /dev/null as stdin
# unless they are given an explicit redirection, so the terminal is handed over
# on fd 3. The TUI still shares this script's process group, which is the
# pane's foreground group, so it keeps reading the terminal.
exec 3<&0
opencode2 --server "$server_url" "$directory" <&3 3<&- &
tui_pid=$!
exec 3<&-

status=0
wait "$tui_pid" || status=$?
tui_pid=""
exit "$status"
