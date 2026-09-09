# antigravity-turn-completion-2443 — one turn, read three times

The transcript Issue #2443 is pinned on: a single agy turn whose **interim
narration has the same shape as its conclusion**, captured at three moments.
`tests/fixtures/antigravity-turn-growth-2438` is the two-stage version of the
same idea; this one adds the stage between them — agy going back to work — which
is what makes "the turn ended" and "the turn was saved" different questions.

Used by `tests/unit/hooks/sources/antigravity-turn-completion-2443.test.ts` and
`tests/unit/lib/polling/structured-history-gate-completion-2443.test.ts`.

## Provenance — read this before treating it as captured data

**Every line here is synthetic.** The records reproduce the *shape* of
`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
— the complete transcript, not the abbreviated `transcript.jsonl` beside it — but
no sentence in them is anybody's real conversation, and no conversation id,
worktree name or prompt is carried over from one.

What is carried over from the survey quoted in the Issue (52 files / 113 turns on
a private machine, 2026-09-09; **not in this repository and not re-measured
here**) is the structure and the timing envelope:

| Reported there | Reproduced here |
|---|---|
| an early `PLANNER_RESPONSE` with prose and no `tool_calls`, partway through a turn | `step_index: 3` |
| the conclusion arriving on a later `PLANNER_RESPONSE` of the **same** turn | `step_index: 6` |
| agy going back to a tool between the two | `step_index: 4` (`tool_calls`), `step_index: 5` (`SYSTEM_MESSAGE`) |
| early candidate → next record: min 3 / median 58 / **max 156** seconds | 156 s exactly, `00:00:05Z` → `00:02:41Z` |
| final candidate → next record: min 9 / median 113 / max 118 seconds | 118 s, `00:02:44Z` → `00:04:42Z` |
| every candidate, early and final, carries `status: DONE` | all of them do here |

The 156 s gap is in the fixture so that a rule keyed on **elapsed time** fails
against it: the interim record is followed by a longer silence than the
conclusion is. The tests assert that the verdict does not move when the gap is
changed, so the number is a control rather than an input.

`truncated_fields` appears on no record here, deliberately: the survey found it
on 4 of the 7 final candidates and 0 of the 8 early ones, and that is a
correlation nobody has shown to be a completion signal. A fixture that carried it
would invite a rule that reads it.

## Files

**`concluded.jsonl` is the source of truth.** The other two are its first N
lines, so the three reads cannot drift into being different turns.

### `interim.jsonl` — steps 0–3, what the poller sees first

Ends on a `PLANNER_RESPONSE` with prose and no `tool_calls`, so
`isAntigravityTurnClosingRecord` calls the turn finished and the row is written.
`INTERIM_NARRATION:` marks the body that must never be delivered as the answer.
The Japanese sentence after it is there because the wording rules #2443 rejects
("waiting", "Waiting for") are language-specific; the tests re-run the same
scenario with the sentence replaced by English prose and expect the same verdicts.

### `resumed.jsonl` — steps 0–5, agy back at work

Adds the `PLANNER_RESPONSE` that reaches for a tool again (156 s later) and the
`SYSTEM_MESSAGE` announcing the result. The turn is **open** again here, which is
the state a row saved from `interim.jsonl` is stranded in.

### `concluded.jsonl` — steps 0–6, the answer

Adds the final `PLANNER_RESPONSE`. `ZARQUON-742` is a unique string, so a test
asserting the conclusion reached History cannot pass on a substring of anything
else. The turn is closed again and the rendered body is strictly longer than
either earlier read's, which is the only condition under which the row is
replaced.

## What is not here

No fixture reproduces a `Stop` event: it is not a transcript record. It arrives
as a hook post and is read back through `session/agent-event-state`'s
`getLastStopEventAt`, so the tests supply it as a timestamp beside the file.
