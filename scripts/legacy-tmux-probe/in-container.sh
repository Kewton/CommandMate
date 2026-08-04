#!/usr/bin/env bash
#
# Issue #1641: container-side half of the legacy-tmux verification.
#
# THIS FILE IS THE ONLY PLACE IN THE HARNESS THAT RUNS tmux, and it is meant to
# run only inside a throwaway container (`docker run`, or a `container:` CI job).
# The host-side driver (`scripts/verify-legacy-tmux-readmode.sh`) contains no
# tmux invocation at all, which is what keeps the 2026-08-02 incident — a live
# test that believed `TMUX_TMPDIR` isolated it and then `kill-server`'d every
# mcbd-* session on the developer's machine — structurally impossible here.
#
# Two refusals below make "throwaway" enforceable rather than aspirational:
# CM1641_IN_CONTAINER must be set, and the default tmux server must hold no
# mcbd-* session. Either one alone would have stopped that incident.
#
# The container's tmux layout mirrors production so the measurement means
# something:
#
#   - default socket : a decoy server with a session, standing in for "the user's
#                      other sessions". Production code must never touch it.
#   - -L $SOCKET     : the private server everything under test runs against.
#                      $TMUX is pointed here so the socket-less production code
#                      follows it (`-L`/`-S` > `$TMUX` > `TMUX_TMPDIR`).
#
# Inputs : PROBE_DIR (default /probe) holding probe.cjs + fixture.txt
#          EXPECT_SUPPORTED=1 to assert the 3.2+ install path instead
# Outputs: $PROBE_DIR/report.json plus one `RESULT:` line per assertion.
set -euo pipefail

PROBE_DIR="${PROBE_DIR:-/probe}"
SOCKET=cm1641
SESSION=mcbd-legacy-1641
OTHER=other-session-1641
DECOY=decoy-default-1641
MARKER='CM1641-PLAN-B-MARKER'
SOCKET_PATH="/tmp/tmux-$(id -u)/${SOCKET}"

if [ "${CM1641_IN_CONTAINER:-0}" != 1 ]; then
  echo "refusing to run: set CM1641_IN_CONTAINER=1, and only inside a throwaway container" >&2
  exit 1
fi
if tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -q '^mcbd-'; then
  echo "refusing to run: the default tmux server holds mcbd-* sessions (this is not a throwaway host)" >&2
  exit 1
fi

fail=0
result() { # result <name> <ok|ng> <detail...>
  printf 'RESULT:%s:%s:%s\n' "$1" "$2" "${*:3}"
  [ "$2" = ok ] || fail=1
}

# Read a dotted path out of the probe's JSON report.
field() {
  node -e 'const r=require(process.argv[1]);let v=r;for(const k of process.argv[2].split(".")){v=v==null?v:v[k];}process.stdout.write(String(v??""))' \
    "${PROBE_DIR}/report.json" "$1"
}

echo "### tmux: $(tmux -V)"

# The decoy lives on the DEFAULT socket precisely because production code that
# ignored $TMUX would land here.
tmux new-session -d -s "$DECOY" 'sleep 900'

# 200x1000 is the production geometry (#1163). The pane prints a real capture
# fixture so Plan B has something to squeeze, then idles.
tmux -L "$SOCKET" new-session -d -x 200 -y 1000 -s "$SESSION" \
  "printf '%s\\n' '${MARKER}'; cat '${PROBE_DIR}/fixture.txt'; sleep 900"
tmux -L "$SOCKET" new-session -d -s "$OTHER" 'sleep 900'
sleep 1

[ -S "$SOCKET_PATH" ] || { echo "no private socket at $SOCKET_PATH"; exit 1; }

# Redirect the socket-less production code onto the private server. probe.ts
# refuses to run if this did not take effect.
export TMUX="${SOCKET_PATH},0,0"
export HOME="${PROBE_DIR}/home"
mkdir -p "$HOME"

echo "### running production read-mode code"
if node "${PROBE_DIR}/probe.cjs" "${PROBE_DIR}/report.json" "$SESSION" "$SOCKET" "$MARKER"; then
  echo "### probe exited 0"
else
  echo "### probe FAILED"
  exit 1
fi

# ---- assertions ------------------------------------------------------------
# Read the private server WITHOUT $TMUX so the -L pinning is what resolves it.
priv() { env -u TMUX tmux -L "$SOCKET" "$@"; }

binding="$(priv list-keys -T prefix g 2>/dev/null || true)"
supported="$(field supportsDisplayPopup)"
outcome="$(field reconcile.outcome)"

if [ "${EXPECT_SUPPORTED:-0}" = 1 ]; then
  if [ "$supported" = true ]; then result probe-supported ok "supportsDisplayPopup=true"
  else result probe-supported ng "expected true, got $supported"; fi
  if [ "$outcome" = installed ]; then result outcome ok "$outcome"
  else result outcome ng "expected installed, got $outcome"; fi
  case "$binding" in
    *display-popup*) result binding ok "installed on private server" ;;
    *) result binding ng "expected a display-popup binding, got [$binding]" ;;
  esac
else
  if [ "$supported" = false ]; then result probe-supported ok "supportsDisplayPopup=false"
  else result probe-supported ng "expected false, got $supported"; fi
  if [ "$outcome" = unsupported-tmux ]; then result outcome ok "$outcome"
  else result outcome ng "expected unsupported-tmux, got $outcome"; fi
  if [ -z "$binding" ]; then result binding ok "prefix+g left unbound"
  else result binding ng "binding was installed: [$binding]"; fi
fi

# The whole point of the no-op: the rest of the user's tmux is untouched.
if priv list-sessions -F '#{session_name}' 2>/dev/null | grep -qx "$OTHER"; then
  result other-session-alive ok "$OTHER still running"
else
  result other-session-alive ng "$OTHER disappeared"
fi
if env -u TMUX tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -qx "$DECOY"; then
  result decoy-alive ok "default-socket session untouched"
else
  result decoy-alive ng "default-socket session disappeared"
fi
if env -u TMUX tmux list-keys -T prefix g 2>/dev/null | grep -q display-popup; then
  result decoy-unbound ng "production code leaked a binding onto the default socket"
else
  result decoy-unbound ok "default socket has no display-popup binding"
fi

# Plan B must work on every tmux version — that is its reason for existing.
planb_ok="$(field planB.ok)"
planb_marker="$(field planB.containsMarker)"
if [ "$planb_ok" = true ] && [ "$planb_marker" = true ]; then
  result plan-b ok "capturePane+squeeze: $(field planB.rawLines) -> $(field planB.squeezedLines) lines, marker found"
else
  result plan-b ng "ok=${planb_ok} marker=${planb_marker} $(field planB.error)"
fi

priv kill-session -t "=${SESSION}:" 2>/dev/null || true
priv kill-session -t "=${OTHER}:" 2>/dev/null || true
env -u TMUX tmux kill-session -t "=${DECOY}:" 2>/dev/null || true

exit "$fail"
