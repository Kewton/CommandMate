# claude-transcript-2265 — the two shapes of a `<command-…>` record

The fixture for Issue #2265, which is about the turn a **slash command** opens.
Claude records `/release v0.30.1` and `/model` with the same three tags, and
before this Issue the reader excluded both — so a `/release` turn was never
opened, its reply was folded into the turn before it (already saved), and the
reader's "nothing to write" answer also suppressed the scraper's copy. The reply
reached History by no path at all.

Used by `tests/unit/hooks/sources/claude-slash-turn-2265.test.ts` and
`tests/integration/claude-slash-turn-2265.test.ts`.

## The census the split rests on

Every `type: "user"` record under `~/.claude/projects` on 2026-09-03 whose text
opens with one of the `<command-…>` tags — 222 records across 18 Claude Code
versions:

| leading tag | count | `<command-name>` values seen |
|---|---|---|
| `<command-message>` | 118 | `/orchestrate`, `/release`, `/uat`, `/worktree-cleanup`, `/worktree-new`, `/multi-stage-design-review`, `/cmate-*` |
| `<command-name>` | 104 | `/model`, `/compact`, `/clear`, `/login`, `/plan` |

The split is exact: **every** `<command-message>`-first record is a project or
user command the agent then answers, and **every** `<command-name>`-first record
is a command Claude Code runs itself, whose whole output is the
`<local-command-stdout>` record behind it. That is why the leading tag is the
rule and not a list of command names.

Two more counts from the same pass, both of which the code depends on:

- **`origin`.** All 46 `<command-message>` records written by Claude Code
  2.1.238 or later carry `origin: {"kind": "human"}`; the 72 written by 2.1.220
  … 2.1.235 carry neither `origin` nor `promptSource`, because the fields did not
  exist yet. So `isClaudeOperatorPromptRecord` answers true on current versions
  and false on old ones, which costs the `user` row and keeps the reply.
- **`isMeta`.** Not one of the 222 records has it. A rule that expected to filter
  these on `isMeta` would filter nothing.

## Provenance — read this before treating it as captured data

**The record shapes are real; the message bodies are not, and the two files are
each spliced from a real session.** Every line here started as a line of a live
transcript and was redacted by the rules below rather than typed out, so the
field names, casing, nesting and co-occurrence of flags are Claude's.

| | |
|---|---|
| Captured | 2026-09-03 |
| Claude Code version | 2.1.258 (the `version` field is kept on every line) |
| `release-slash-turn.jsonl` source | the measured incident itself — the session that ran `/release v0.30.1` at 2026-09-02T23:20:35.205Z, the one the Issue's `structured-history-scrape-suppressed` line came from |
| `local-command-turn.jsonl` source | that same session's turn A, followed by a real `/model` triple captured from a second session on the same machine |

### What was changed, and nothing else

- every `uuid` / `parentUuid` / `promptId` / `toolUseID` →
  `00000000-0000-4000-8000-0000000000NN`, allocated in first-seen order;
- `parentUuid` was then re-linked to the previous record in the file, because
  records were spliced out of a longer session and the original chain would name
  records that are not here;
- `msg_…` / `toolu_…` / `req_…` → synthetic ids of the same shape, and each
  `tool_use` id still matches its `tool_result`;
- `sessionId` / `session_id` → `7c4a9e20-2265-4b00-9000-0000000000aa`,
  `cwd` → `/Users/operator/repos/commandmate-issue-2196`, `gitBranch` →
  `develop`, the hook URL's `worktreeId` / `instanceId` → the fixture's;
- the `thinking` block's `signature` → a short placeholder;
- long message bodies truncated with a `…（fixture: 以降は省略）` marker — the
  skill expansion was 18 KB and the replies several KB each, and nothing after
  the first paragraph is what the tests read.

**The `<command-message>` record's own text is verbatim.** It is the record
under test; editing it would prove nothing.

## Files

### `release-slash-turn.jsonl` — three turns, the middle one a slash command

Seventeen records. Turn A and turn C are ordinary typed prompts
(`origin: {"kind": "human"}`, `promptSource: "typed"`) with a closing `end_turn`
reply; turn B is `/release v0.30.1`.

Turn B is the whole point, and it is here in the shape Claude actually writes it:

1. the `<command-message>` record — `origin: {"kind": "human"}`, **no
   `promptSource`**, `isMeta` absent;
2. an `isMeta: true` record holding the *body* of the skill the command expands
   to, which must never be mistaken for the prompt;
3. an `attachment` of type `command_permissions`, a record type that appears
   only on a slash turn;
4. the reply: an empty `thinking` block, prose, a `Bash` `tool_use`, its
   `tool_result`, and a closing `end_turn` record with prose on it.

Prompt uuids, which are the turn keys (`claude-turn:<uuid>` /
`claude-prompt:<uuid>`):

- A `00000000-0000-4000-8000-000000000003` — 2026-09-02T23:14:30.635Z
- B `00000000-0000-4000-8000-000000000012` — 2026-09-02T23:20:35.205Z
- C `00000000-0000-4000-8000-000000000024` — 2026-09-03T00:32:46.013Z

Six minutes separate A from B, which is what puts a `/send` row written at A's
end outside #2196's symmetric two-minute window and keeps #2246's
`adoptionFromMs` in the picture for a slash prompt too.

### `local-command-turn.jsonl` — one ordinary turn, then `/model`

Seven records: turn A again, then the three records a built-in command writes —
the `isMeta` `<local-command-caveat>`, the `<command-name>`-first record, and the
`<local-command-stdout>` that is the command's whole output. There is no
assistant record after them because the agent is never asked anything.

This is the file that pins the negative half of #2265: the reader must open
**one** turn here, not two, and History must gain no row whose text is
`/model` or the XML around it. Note that the `<command-name>` record contains a
`<command-message>` tag as its *second* line — the rule is the leading tag, and
this file is why it has to be.

## What is not here

- **A `<command-message>` record with no arguments.** All 118 in the census
  carried a non-empty `<command-args>`, so there was no honest way to capture
  one. `claudeSlashCommandPrompt` still has to handle it — a command can be typed
  bare — and the coverage for that is synthetic, in the unit test, and labelled
  as such.
- **A `<local-command-stdout>` behind a `<command-message>` record.** Not
  observed: a project command's output is the agent's reply, not a local record.

**Do not "tidy" these files.** As with `../claude-transcript-2196` and
`../claude-transcript-2246`, the point is that the field names and the
co-occurrence of flags are Claude's and not ours.
