# antigravity-transcript-2264 — a turn cut off after its tool call

The antigravity half of Issue #2264. agy has **no record that closes a turn** —
fact 4 of `../transcripts/antigravity/README.md`, established over a 41-file,
1,024-record corpus — so the reader's evidence that a turn is finished has to be
the shape of the last thing agy wrote, and this pair is what pins it.

Used by `tests/unit/hooks/sources/antigravity-turn-closed-2264.test.ts`.

## Provenance — read this before treating it as captured data

**Every line is a record from
`../transcripts/antigravity/transcript-three-turns-1118.jsonl`**, the unmodified
agy 1.1.18 capture from 2026-09-01 (paths anonymised there, nothing else). No
field of any record was edited except `step_index` and `created_at` on the two
records that had to be moved into turn C:

| Record | Copied from | Fields changed |
|---|---|---|
| turn C's `list_dir` `PLANNER_RESPONSE` | turn B's `step_index: 10` | `step_index` → 14, `created_at` → turn C's |
| turn C's reply | the capture's `step_index: 14` | `step_index` → 15 |

Turns A and B are the capture's own turns A and B, unchanged — including the fact
that **turn B really does end on a tool call with no reply after it**, because
the operator typed the next prompt while agy was still hunting for `NOTES.md`.
That is not a defect in the capture; it is the shape that proves the closed rule
cannot be the only rule, and why `AntigravityTurnAccumulator.superseded` exists.

## Files

### `turn-open.jsonl` — agy mid-loop

Turn C (`step_index: 12`) ends on a `PLANNER_RESPONSE` that carries a
`tool_calls` entry and no prose. Its body renders **non-empty** — the tool line
is in it — so the writer's emptiness guard does not fire, which is the antigravity
form of the same hole #2264 was reported for against claude.

### `turn-closed.jsonl` — the same turn after agy answered

`turn-open.jsonl` plus the `PLANNER_RESPONSE` carrying the reply (`**THIRD TURN
OK**` and a two-item list) and no `tool_calls`. That record — prose, no call — is
what "closed" means for agy.

**Do not "tidy" these files.** The field names, the `USER_REQUEST` wrapper and
the co-occurrence of prose with `tool_calls` are agy's and not ours.
