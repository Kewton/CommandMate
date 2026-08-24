# claude-live-2011 — idle Claude panes with no completion marker

Captured 2026-08-24 for Issue #2011, from one live **Claude Code 2.1.241**
session driven inside a private tmux server (`tmux -L cm2011`) on a **200x1000**
pane — the geometry `src/lib/tmux/tmux.ts` pins for real worktree sessions, and
the geometry every rule in `tools/claude/` was measured at. Frames were taken
with `tmux capture-pane -p -e`, so all SGR is as captured.

Only two strings were rewritten, byte-for-byte in place: the operator's display
name (`Welcome back Kota!` → `Welcome back User!`, same length) and the account
email (`newtons.boiled.clock@gmail.com` → `operator.dev@example-team.test`, same
length). Nothing else was touched.

## Why this set exists

Issue #1927 gave Claude a §4 D1 idle rule — the turn-completion marker
`✻ <Verb> for <N>s` at the transcript tail — and then derived
`isUnclassifiedActive` from whether that rule vouched. On 2026-08-24, **7 of 8
live idle Claude panes did not have a marker at the tail**, because the last
thing on screen was a chrome row Claude pins above the composer. Every one of
them opened `TerminalEscapeHatch` and stopped `commandmate wait` completing.

These frames are that measurement, made re-runnable. The rule's verdict on them
is not wrong — they really do carry no completion marker — so the fixtures are
NOT here to be made `'positive'`. They are here to pin that a frame with no
proof is still a frame that was **read**.

## The frames

| file | tail row above the input box | verdict | provenance |
|---|---|---|---|
| `help-overlay.txt` | (no composer at all) | `running`/`default`, evidence `none` | verbatim |
| `idle-turn-complete-marker.txt` | `✻ Churned for 2s` | `ready`/`input_prompt`, evidence `positive` | verbatim |
| `idle-tail-model-saved.txt` | `⎿ Set model to Opus 5 (1M context) and saved as your default for new sessions` | `ready`/`input_prompt`, evidence `none` | verbatim (produced by `/model`, re-selecting the already-default entry) |
| `idle-tail-command-result.txt` | `⎿ Cancelled memory editing` | `ready`/`input_prompt`, evidence `none` | verbatim (produced by `/memory` then Esc) |
| `idle-tail-tip-memory.txt` | `⎿ Tip: Use /memory to view and manage Claude memory` | `ready`/`input_prompt`, evidence `none` | **derived** |
| `idle-tail-new-task-clear.txt` | `new task? /clear to save 196.1k tokens` | `ready`/`input_prompt`, evidence `none` | **derived** |
| `idle-tail-update-installed.txt` | `✔ Update installed · Restart to update` | `ready`/`input_prompt`, evidence `none` | **derived** |

`help-overlay.txt` is the **positive control**, and the one row of this set that
belongs on the 別表 in `tests/unit/detection/tools/unclassified-frames.test.ts`.
Claude's `/help` overlay paints over the composer entirely — no input box, no
status row — so nothing in the chain can read it and the frame lands on the
`default` floor. A change that made `isUnclassifiedActive` false everywhere would
satisfy all six other files here and break the hatch this one protects.

### The three derived frames

`idle-tail-command-result.txt` is the base. Its single transcript-tail row is
replaced with the row named in the table, and nothing else in the 1000-row frame
changes — same chrome, same box geometry, same SGR, same blank-row run between
the transcript and the input box. The tail rows themselves are verbatim from the
Issue #2011 field measurement (`GET /api/worktrees/<id>/current-output` against
the seven live panes, 2026-08-24).

They are derived rather than captured because none of the three is reproducible
on demand: `⎿ Tip:` rows appear on Claude's own schedule, `new task? /clear to
save …` needs ~200k tokens of context, and `✔ Update installed` needs a
background auto-update to have landed. What they vary is exactly one thing — the
text of the row `findClaudeTranscriptTail` lands on — which is the variable under
test, so the substitution is the experiment rather than a shortcut around it.

The two verbatim rows in the same class (`⎿ Set model to …`, `⎿ Cancelled memory
editing`) are what makes the substitution credible: they were captured live from
the same session and produce the same verdict.

## Re-capturing

Run `claude` in a **private** tmux server at 200x1000 and drive it by hand:

```
tmux -L cm2011 new-session -d -s probe -x 200 -y 1000
tmux -L cm2011 send-keys -t '=probe:' -l -- 'claude'
tmux -L cm2011 send-keys -t '=probe:' Enter
# … drive the session, then:
tmux -L cm2011 capture-pane -p -e -t '=probe:' > frame.txt
tmux -L cm2011 kill-session -t '=probe:'
```

`-L` is mandatory and `kill-server` must never be written without it: a worker
runs inside a tmux pane whose `$TMUX` points at the operator's own server, and
`-L`/`-S` outrank `$TMUX` while `TMUX_TMPDIR` is ignored entirely.
