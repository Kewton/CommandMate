#!/usr/bin/env bash
#
# Issue #1641: prove the reading-mode capability probe is a real no-op on tmux
# older than 3.2, by running the shipped code against real old tmux binaries.
#
# #1623 covered both probe branches with mocks and closed with the acceptance
# item "no-op on display-popup-less tmux" UNVERIFIED, because the only tmux on
# hand was 3.5a. Mocking a probe's return value cannot tell you whether the probe
# asks tmux the right question. This harness answers that by execution.
#
#   host  : bundles src/lib/tmux/{read-mode,tmux,transcript-squeeze} with esbuild
#           and drives docker. It NEVER runs tmux — grep this file for `tmux` and
#           you will find it only in comments, image names and the path of the
#           container-side script. That is deliberate: on 2026-08-02 a live test
#           that believed it was isolated killed every mcbd-* session on the
#           developer's machine, and the cheapest guarantee against a repeat is a
#           driver with no tmux invocation in it at all.
#   guest : scripts/legacy-tmux-probe/in-container.sh, which pins everything to a
#           `-L` private server inside a throwaway container.
#
# Usage:
#   scripts/verify-legacy-tmux-readmode.sh            # full matrix
#   scripts/verify-legacy-tmux-readmode.sh 3.1c       # one row, by version label
#   CM1641_INVERT_EXPECT=1 scripts/... 3.1c           # non-vacuity check
#
# `CM1641_INVERT_EXPECT=1` flips every row's expectation, so a row now passes
# only if the assertions FAIL. A green run in that mode means the assertions
# actually read the measurement instead of being inert — the cheapest defence
# against a suite that would stay green no matter what tmux did.
#
# Exit 0 only when every row asserted clean.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE_DIR="${REPO_ROOT}/scripts/legacy-tmux-probe"
FIXTURE="${REPO_ROOT}/tests/unit/lib/tmux/fixtures/capture-claude-idle.txt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# image | tmux version label | expect display-popup support | extra setup
#
# bullseye (3.1c) is the headline row: the newest tmux that still lacks
# display-popup, so it is the one a real user is most likely to be running.
# buster (2.8) is kept because `list-commands` there does not take a command
# argument at all, which is a different code path through the same probe.
# bookworm (3.3a) is the control: the same code must INSTALL there, otherwise a
# green legacy row would only prove the probe always says "no".
MATRIX=(
  "node:18-buster|2.8|0|sed -i 's|deb.debian.org|archive.debian.org|g; s|security.debian.org|archive.debian.org|g; /buster-updates/d' /etc/apt/sources.list && printf 'Acquire::Check-Valid-Until \"false\";\n' > /etc/apt/apt.conf.d/99no-check"
  "node:18-bullseye|3.1c|0|true"
  "node:18-bookworm|3.3a|1|true"
)

only="${1:-}"

echo "==> bundling production modules with esbuild"
npx --no-install esbuild "${PROBE_DIR}/probe.ts" \
  --bundle --platform=node --format=cjs --target=node18 \
  --tsconfig="${REPO_ROOT}/tsconfig.json" \
  --outfile="${WORK}/probe.cjs" >/dev/null

cp "$FIXTURE" "${WORK}/fixture.txt"
cp "${PROBE_DIR}/in-container.sh" "${WORK}/in-container.sh"
chmod +x "${WORK}/in-container.sh"

overall=0
for row in "${MATRIX[@]}"; do
  IFS='|' read -r image label expect setup <<<"$row"
  if [ -n "$only" ] && [ "$only" != "$label" ]; then continue; fi
  if [ "${CM1641_INVERT_EXPECT:-0}" = 1 ]; then
    expect=$((1 - expect))
  fi

  echo
  echo "==================================================================="
  echo "==> ${image}  (expecting tmux ${label}, display-popup support=${expect})"
  echo "==================================================================="
  rundir="${WORK}/${label}"
  mkdir -p "$rundir"
  cp "${WORK}/probe.cjs" "${WORK}/fixture.txt" "${WORK}/in-container.sh" "$rundir/"

  rc=0
  docker run --rm -e "EXPECT_SUPPORTED=${expect}" -e CM1641_IN_CONTAINER=1 \
    -v "${rundir}:/probe" "$image" bash -c "
      set -e
      export DEBIAN_FRONTEND=noninteractive
      ${setup}
      apt-get update -qq >/dev/null 2>&1
      apt-get install -y -qq tmux >/dev/null 2>&1
      exec /probe/in-container.sh
    " || rc=$?

  if [ "${CM1641_INVERT_EXPECT:-0}" = 1 ]; then
    # Inverted run: the assertions are supposed to reject this tmux.
    if [ "$rc" != 0 ]; then
      echo "==> ${label}: PASS (inverted expectation was correctly rejected)"
    else
      echo "==> ${label}: FAIL (assertions are inert — they pass either way)"
      overall=1
    fi
  elif [ "$rc" = 0 ]; then
    echo "==> ${label}: PASS"
  else
    echo "==> ${label}: FAIL"
    overall=1
  fi
done

echo
if [ "$overall" = 0 ]; then echo "ALL ROWS PASS"; else echo "SOME ROWS FAILED"; fi
exit "$overall"
