# turn-separation-2234 — one real Claude Code turn that opens with a tool log

The specimen Issue #2234 was measured on: a turn whose stored body used to begin
with two `- \`Bash\` — …` lines, so the chat bubble (#2232 shows the body in
full) opened with a tool log instead of a reply.

Used by `tests/unit/hooks/sources/turn-separation-2234.test.ts`.

## Provenance

| | |
|---|---|
| Captured | 2026-09-02 |
| Source | `~/.claude/projects/-Users-maenokota-share-work-github-kewton-commandmate-issue-1950/f9cd4614-5f66-470c-b85f-9ab45ec60005.jsonl`, lines 985–1014 |
| Claude Code version | on every line, in the records' own `version` field |
| Shape | one JSON record per line, exactly as Claude appends them — **unedited** |

The window was cut at the turn boundary the production reader uses: it opens on
the `type: "user"` record whose `uuid` is `69cbea87-…` and ends at the record
before the next prompt. Nothing inside was rewritten, so the file still carries
the `attachment`, `queue-operation`, `last-prompt`, `ai-title`, `mode`,
`permission-mode`, `atis-latch`, `bridge-session` and `system` record types that
sit between the assistant records in a live transcript — the reader has to walk
past all of them to reach the six blocks that make the body.

## The census this turn was chosen from

Every turn in the newest 400 of the 714 transcripts on the capture machine was
rendered with `renderClaudeTurn` as it stood at `362b6814`:

| | count |
|---|---|
| non-empty turns | 586 |
| bodies whose first line is a tool line | **141 (24 %)** |
| bodies whose first line is prose | 445 |
| bodies whose first line is a `Thinking` quote | 0 |

The full measurement, including the two censuses that decided *how* the split is
made, is in `docs/design/2234-turn-prose-tool-separation.md`.

## The files

| file | what it is |
|---|---|
| `claude-tool-first-turn.jsonl` | the 30 raw records |
| `claude-tool-first-turn.before.md` | the body `renderClaudeTurn` produced at `362b6814` — the shape **already saved in `chat_messages`** for every row written before this Issue |
| `claude-tool-first-turn.after.md` | the body it produces now |

`before.md` is not a historical curiosity. Existing rows are never rewritten —
`writeClaudeTurn` stands down on `findMessageByRequestId` — so that exact text is
what History still holds and still renders, and the test asserts it survives the
card's Markdown pipeline unchanged.

Both `.md` files carry one trailing newline that the body itself does not; the
test compares against the file with that newline stripped.
