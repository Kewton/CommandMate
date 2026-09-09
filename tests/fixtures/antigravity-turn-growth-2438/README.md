# antigravity-turn-growth-2438 — the same turn, before and after its conclusion

The pair Issue #2438 is pinned on: one turn read twice, first while agy was
still waiting on a worker and again once it had answered. The first read is what
the reported defect saved forever — a row keyed
`antigravity-turn:<conversationId>#0` holding an interim report — and the second
read is the transcript that already held the conclusion the row is missing.

Used by `tests/unit/hooks/sources/antigravity-turn-growth-2438.test.ts`.

## Provenance — read this before treating it as captured data

**These lines are synthetic.** They reproduce the *record shape* of
`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
— the complete transcript, not the abbreviated `transcript.jsonl` beside it —
but no sentence in them is anybody's real conversation. The observed failure was
in a private session (2026-09-09, release 0.33.1, `:60301`, worktree
`rag-document`, conversation `b8ae0056-01ad-484e-8e6d-ed63522b4060`), whose
transcript is not in this repository and is not needed to reproduce the bug.

What is carried over from that session, and is the only thing the tests depend
on, is its **structure**:

| Observed there | Reproduced here |
|---|---|
| one `USER_EXPLICIT` / `USER_INPUT` in the whole file, at `step_index: 0` | `step_index: 0`, so both files hold exactly one turn |
| an interim `PLANNER_RESPONSE` — prose, no `tool_calls` — partway through | `step_index: 3` |
| the conclusion arriving on a later `PLANNER_RESPONSE` of the same turn | `step_index: 5` |
| tool output and `SYSTEM` records interleaved between the two | `step_index: 2` (`GENERIC`), `step_index: 4` (`SYSTEM_MESSAGE`) |

The real pair rendered to 16,959 and 21,581 characters. **That is not
reproduced and must not be asserted on**: these files are two orders of
magnitude smaller, and the tests read `renderAntigravityTurn` itself rather than
any length written down here.

## Files

### `intermediate.jsonl` — what the poller saw first

`step_index` 0–3. The last record is a `PLANNER_RESPONSE` carrying prose and no
`tool_calls`, so `isAntigravityTurnClosingRecord` calls the turn finished and the
writer saves it — which is the whole defect: agy had said "waiting for the
worker", not "here is the answer".

### `completed.jsonl` — the same file two records later

`intermediate.jsonl` plus the `SYSTEM_MESSAGE` announcing the worker's result and
the `PLANNER_RESPONSE` carrying `FINAL_RESULT`. Same conversation, same
`step_index: 0` turn, same row key. The rendered body is strictly longer than
the first read's, which is the only condition under which
`growAntigravityTurnRow` replaces a row.

**`completed.jsonl` is the source of truth for both files.**
`intermediate.jsonl` is its first four lines, so the two cannot drift apart in a
way that stops being the same turn.
