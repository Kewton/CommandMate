# claude-transcript-2264 — one turn caught before its last paragraph

The fixture for Issue #2264, which is about a turn that **a writer records too
early**: the `stop` hook fires when the agent considers the turn over, the last
assistant record reaches the JSONL a moment later, and a reader that arrives in
between saves a reply with no prose in it — permanently, because the row is keyed
on the prompt's `uuid` and every later read answers "already saved".

Measured on 2026-09-03 (`mycodebranchdesk`, instance `claude-2`): **9 of 20
turns** were saved that way, and the typical row was 236 characters of
`> **Tool calls (1)**` with not one character of the answer in it.

Used by `tests/unit/hooks/sources/claude-turn-closed-2264.test.ts` and
`tests/integration/stop-history-capture-2246.test.ts`.

## Provenance — read this before treating it as captured data

**Every line is a record from `../claude-transcript-2246/three-turns.jsonl`**,
which is itself the shape-preserving derivation of a live 2026-09-01 transcript
documented in that directory's README. Records are reused verbatim; the three
files here differ from it only in **which records are present**, plus these
fields on the records that had to be re-stamped so the chain stays consistent:

| Record | Copied from | Fields changed |
|---|---|---|
| turn C's `tool_use` assistant record | turn B's (`…0007`) | `uuid`, `parentUuid`, `timestamp`, `message.id`, `requestId`, the `tool_use` block's `id`, `name` and `input` |
| turn C's `tool_result` user record | turn B's (`…0008`) | `uuid`, `parentUuid`, `timestamp`, `sourceToolAssistantUUID`, `tool_use_id`, the result text |
| turn C's `thinking` assistant record | turn C's text record (`…0013`) | `uuid`, `parentUuid`, `timestamp`, `message.id`, `requestId`, and `message.content` replaced by one `thinking` block |

Nothing else was touched. In particular `message.stop_reason` is Claude's own
value on every record — `end_turn` on the ones that end a reply, `tool_use` on
the ones that hand over to a tool — which is the whole point of the fixture and
the field #2264 exists because nobody read.

Turns A and B are the 2246 file's turns A and B, unchanged and both closed. Only
turn C (`00000000-0000-4000-8000-000000000011`, key `claude-turn:…0011`) differs
between the three files.

## Files

### `turn-open.jsonl` — the state the Stop hook actually sees

Turn C stops at its `tool_use` record (`stop_reason: "tool_use"`). This is the
one that matters: `renderClaudeTurn` draws tool calls as a trailing section, so
the body is **non-empty** — the writer's emptiness guard cannot see anything
wrong with it, and before #2264 it was written and frozen.

### `turn-closed.jsonl` — the same turn a second later

`turn-open.jsonl` plus the `tool_result` and the `end_turn` text record that
follows it, so the body grows from tool calls alone to tool calls *and* the
reply. Reading this after the row was written short is what
`updateMessageContent` is for.

### `turn-thinking-only.jsonl` — `end_turn` that is not the end

`turn-open.jsonl` plus an assistant record carrying `stop_reason: "end_turn"`
whose only block is `thinking`. The shape the Issue measured once, and the reason
`end_turn` alone is not the closed rule: Claude Code resumes after it, so a
writer that trusted the field by itself would save the turn one paragraph short
in exactly the way this Issue is about.

**Do not "tidy" these files.** As with `../claude-transcript-2246`, the point is
that the field names and the `stop_reason` values are Claude's and not ours.
