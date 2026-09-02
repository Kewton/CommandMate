# claude-transcript-2246 — one session with three turns, two of which nobody wrote

The fixture for Issue #2246, which is about a turn that **no writer records at
all**: the transcript reader is triggered by the poller deciding a turn
finished, so a poll that misjudges one completion used to lose that turn
permanently — by the next completion, "the newest turn" had moved on.

Used by `tests/unit/hooks/sources/claude-history-backfill-2246.test.ts` and
`tests/integration/claude-history-backfill-2246.test.ts`.

## Provenance — read this before treating it as captured data

**The record *shapes* are real; the conversation is not.** Every line here is a
record from `tests/fixtures/claude-transcript-2196/operator-turn.jsonl` — which
*was* lifted verbatim out of a live transcript on 2026-09-01 — with only these
fields changed: `uuid`, `parentUuid`, `promptId`, `timestamp`, `sessionId` /
`session_id`, `gitBranch`, `message.id`, `requestId`, the `tool_use` id, and the
message bodies. Field names, casing, nesting, the `origin` / `promptSource`
markers, and the co-occurrence of the five record types are Claude's.

The three turns are arranged to the timeline the Issue measured on 2026-09-02
(`mycodebranchdesk`, instance `claude-2`), because that ordering is the thing
under test and no single captured session happens to contain it:

| | prompt | reply | in `chat_messages` before the fix |
|---|---|---|---|
| **A** | 14:20:11 | 14:20:44 | yes — the reader wrote it |
| **B** | 14:38:24 | 14:39:16 | **no** — the poller misjudged the completion |
| **C** | 14:49:26 | 14:50:18 | yes — and it is all History showed |

Eleven minutes separate B's prompt from C's, which is what puts B's `/send` row
outside #2196's symmetric two-minute adoption window and is why
`RecordUserTurnOptions.adoptionFromMs` exists.

## Files

### `three-turns.jsonl` — the whole session, all three turns closed

Fourteen records: three `user` prompts (`origin: {"kind": "human"}`,
`promptSource: "typed"`), three `attachment` records, three text `assistant`
records, one `tool_use` / `tool_result` pair in turn B, and three
`system` / `turn_duration` records. The `attachment` and `system` records are
here for the same reason `../claude-transcript-2196` keeps them: they are types
the reader must ignore without comment, and a two-line invented transcript would
not exercise that.

Prompt uuids, which are the turn keys (`claude-turn:<uuid>` /
`claude-prompt:<uuid>`):

- A `00000000-0000-4000-8000-000000000001`
- B `00000000-0000-4000-8000-000000000005`
- C `00000000-0000-4000-8000-000000000011`

### `three-turns-open.jsonl` — the same session as a Stop hook can see it

Identical, minus turn C's `attachment`, `assistant` and `system` records: the
prompt is written and the reply is not. That is the state the transcript is in
when the `stop` hook beats the file append, and the reason
`captureTranscriptTurnOnStop` retries once — a reader that arrives here answers
false, correctly, because an empty row would be a blank reply forever.

**Do not "tidy" these files.** As with `../claude-transcript-2196`, the point is
that the field names are Claude's and not ours.
