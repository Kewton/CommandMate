# claude-transcript-2196 — real `type: "user"` records, sorted into "the operator" and "not the operator"

Lines lifted out of live Claude Code transcripts
(`~/.claude/projects/<slug>/<session-id>.jsonl`) for Issue #2196, which needs to
decide **which `type: "user"` record is text a person typed** before it can write
that text into `chat_messages` as a `user` row.

Used by `tests/unit/hooks/sources/claude-user-turn-2196.test.ts`.

The Issue's instruction was to look at the real records before choosing the rule
rather than to guess from the Issue text, and the files below are that look. The
rule the census produced is in `isClaudeOperatorPromptRecord`
(`src/lib/hooks/sources/claude/transcript.ts`).

## Provenance

| | |
|---|---|
| Captured | 2026-09-01 |
| Source | 744 transcript files under `~/.claude/projects` on the author's machine |
| Claude Code versions | 2.1.215 … 2.1.252 (the `version` field is kept on every line) |
| Shape | one JSON record per line, exactly as Claude appends them |

## The census this directory was chosen from

Every `type: "user"` record in all 744 files was classified. Of the 4,943 that
survive `isClaudePromptRecord` — that is, after tool results, `isMeta` records
and the `<command-…>` / `<local-command-…>` bookkeeping are dropped:

| | count |
|---|---|
| carries `origin` and/or `promptSource` | 4,909 |
| carries neither | 34 |

All 34 unmarked records were `/compact` or
`[Request interrupted by user for tool use]`. **Not one unmarked record was a
prompt**, and the markers appear on every version in the sample. That is why the
production rule asks for positive evidence (`origin.kind === "human"`, or a
`promptSource` of `typed` / `queued`) instead of denying a list of known-bad
shapes: there was nothing left for a deny list to catch, and a deny list fails
towards *showing* a record shape a later Claude invents.

Observed `origin.kind` values: `human` (528), `task-notification` (279) — no
others.
Observed `promptSource` values: `typed`, `queued`, `system`, `sdk`.

## Files

### `operator-turn.jsonl` — one complete turn, verbatim

A real, small turn: a typed prompt, the `tool_use` it caused, the `tool_result`
that came back, and the reply. Eight records, including the three record types
that are neither `user` nor `assistant` and must be ignored without comment
(`attachment`, `system`, `file-history-snapshot`).

It is the fixture for "one turn produces a user row and then an assistant row, in
that order" — the ordering is the acceptance criterion, and asserting it against
an invented two-line transcript would not have exercised the interleaving.

### `operator-user-records.jsonl` — the two records that are the operator

`promptSource: "typed"` (the composer) and `promptSource: "queued"` (typed while
the previous turn was still running, submitted when it ended). Both carry
`origin: {"kind": "human"}`.

### `non-operator-user-records.jsonl` — the nine that are not

In file order:

1. **`tool_result`** — 4,917 of the 6,290 user records in the newest 60 files
   were these.
2. **`isMeta` `<local-command-caveat>`** — the preamble Claude writes before a
   slash command's expansion.
3. **`<command-name>` bookkeeping** — how a slash command itself is recorded.
4. **`<local-command-stdout>`** — that command's output.
5. **`isMeta` slash-command expansion** — the *body* of a `.claude/commands/*.md`
   file, injected as user text. Thousands of characters of instructions the
   operator never typed; the single most damaging thing to mistake for a prompt.
6. **`origin.kind: "task-notification"` / `promptSource: "system"`** — a
   background task reporting completion.
7. **`isCompactSummary`** — the summary injected after `/compact`.
8. **`interruptedMessageId`** — `[Request interrupted by user for tool use]`.
   Recognised by the field, never by the sentence, which is prose.
9. **`promptSource: "sdk"`** — a headless `claude -p` run. A real instruction
   from a real person, but not one typed at a pane, so there is no chat surface
   for it to belong to.

### What is *not* here: `isSidechain`

Deliberately absent, and worth stating rather than leaving as a gap. **No
`isSidechain: true` record appears in any of the 744 transcripts** (checked
directly; the count was 0), which matches #2121's note that its sampled session
had none — sub-agent conversations go to files of their own on these versions.
`buildClaudeTurns` still skips and counts sidechain records, and the synthetic
coverage for that lives in `claude-transcript-2121.test.ts`. There was no honest
way to put a real one here.

## Redaction

The records are structurally verbatim. What was replaced, and nothing else:

- absolute paths → `/Users/operator/repos/commandmate-issue-2196`, scratch paths
  → `/tmp/agent-scratch`;
- every UUID → `00000000-0000-4000-8000-0000000000NN`, allocated in first-seen
  order so that `parentUuid` chains still line up;
- `msg_…` / `toolu_…` / `req_…` → synthetic ids of the same shape;
- `sessionId` / `session_id` / `gitBranch` / `slug` → fixed values.

Long bodies are truncated with a `…（fixture: 以降は省略）` marker — the
slash-command expansion was 24 KB and the compaction summary 15 KB, and neither
says anything after the first paragraph that the classification depends on. The
compaction summary is cut shortest because the live one recites names.

**Do not "tidy" these files.** The point of them is that the field names, the
casing and the co-occurrence of flags are Claude's and not ours; a record edited
into the shape the code expects proves nothing.
