# `chat-turn-headers-2458`

**This data is SYNTHETIC.** Nothing here was captured from a running agent, a
running server or a real database. It was written by hand for Issue #2458 and
every id, body and clock in it was chosen to make one rule visible.

That is the opposite of the sibling fixture `../chat-transcript-2245/`, which is
a verbatim `GET /api/worktrees/<id>/messages` capture, and the difference is
deliberate. #2245's defect was about the *content* of real rows — 2.8 KB pane
dumps carrying raw `ESC` — so only real bytes could prove it fixed. #2458's
defect is about the *shape of a sequence*: four consecutive saved assistant rows
belonging to four different turns, rendered under one header. A real capture of
that shape would drag several kilobytes of unrelated Markdown along with it, and
the four `request_id`s that actually matter would be invisible in the noise.

## The sequence

`turn-headers.json` is the minimal column Issue #2458's acceptance names. Six
rows, one `claude` instance, in transcript order:

| # | role | clock | `request_id` |
|---|---|---|---|
| 1 | user | 18:18 | `claude-prompt:aaaa…0001` |
| 2 | assistant | 18:33 | `claude-turn:aaaa…0001` |
| 3 | assistant | 18:59 | `claude-turn:bbbb…0002` |
| 4 | assistant | 19:14 | `claude-turn:cccc…0003` |
| 5 | assistant | 19:26 | `claude-turn:dddd…0004` |
| 6 | user | 21:25 | `claude-prompt:eeee…0005` |

Row 2 is the only reply whose question is in the column: its turn key
(`…0001`) renames to row 1's prompt id, so its header is the role label plus
the range `18:18 → 18:33`.

Rows 3–5 are what the Issue was filed about. `recordClaudeUserTurn` does not
write a user row for a turn the operator did not type — a `task-notification`
reply is the case that produced this shape in the field — so three separate
answers arrive back-to-back with no question between them. Each carries a turn
key of its own, so each opens a boundary, and **none of them may reuse 18:18**:
the only thing known about rows 3–5 is when they finished. Their headers are
`18:59`, `19:14` and `19:26`, with no role label repeated.

Row 6 is the operator speaking again — a role change, so the conventional
header comes back — and its own turn has not been answered yet, which is why
no `claude-turn:…0005` exists.

## Why the timestamps have no timezone

`"2026-09-07T18:18:00"` has no `Z` and no offset, so `new Date()` parses it as
**local time** on whatever machine runs the suite. That is what makes `18:18`
an assertable string: the headers render a local 24-hour clock
(`formatChatTurnTime`), and a UTC instant would render as a different time in
every contributor's and every CI runner's timezone. The repository pins no `TZ`
for vitest, so the fixture has to be timezone-free rather than timezone-correct.

The same reason is why a test that renders these rows pins `now` with
`vi.setSystemTime`: the stamp gains its `M/d` prefix once the row is not from
the reference day, and "today" would otherwise be whenever the suite ran.
