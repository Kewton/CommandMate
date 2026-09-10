# `chat-tool-approvals-2460`

The saved rows behind Issue #2460, rebuilt as a synthetic fixture.

## What was measured

`/worktrees/mycodebranchdesk`, Claude pane 2, 2026-09-10 21:46 `/uat 2454`. At
21:48 the `/uat` skill raised one `AskUserQuestion` call with two questions
(*実行範囲* and *起動場所*) and then its submit confirmation. The chat surface
drew all three as one chip group reading **「ツール承認 3 件」**, with:

| row | `promptData` | the chip's label |
|---|---|---|
| 21:48:04 | `isAskUserQuestion: true`, `answeredBy: auto` | `←  ☐ 実行範囲  ☐ 起動場所  ✔ Submit  → この Issue の核心は…` |
| 21:48:06 | `isAskUserQuestion: true`, `answeredBy: auto` | `←  ☒ 実行範囲  ☐ 起動場所  ✔ Submit  → UAT サーバーをどこで起動しますか？` |
| 21:48:11 | no `isAskUserQuestion`, `answeredBy: human` | `● UAT サーバーをどこで起動しますか？ … → worktree で起動 … Ready to submit your answers?` |

## What is verbatim and what is rebuilt

The **shapes** are verbatim: the field set, the tab row, the `Review your
answers` / `● question` / `→ answer` / `Ready to submit your answers?` structure,
the confirmation's `Submit answers` / `Cancel` options, the `answeredBy` values,
and the three timestamps **to the millisecond**.

The **prose** is rebuilt. The original rows are a private worktree's `/uat`
session, and the defect does not depend on their wording. Two rewrites are
deliberate rather than cosmetic:

- the first question is 179 characters, past
  `TOOL_APPROVAL_LABEL_MAX_CHARS` (160), so a merge key built from the elided
  label is detectable. `chat-tool-approvals-2460.test.ts` derives a second
  question that shares its first 160 characters and differs after them;
- `content` and `instructionText` carry an unrelated shell fragment
  (`=== commandcode インストール状況 ===`), which the measured confirmation row had
  as well. It is what a label fallback that read either field would print.

## The clock is the assertion

`21:48:06.000 → 21:48:11.000` is **exactly 5,000 ms**, which is
`TOOL_APPROVAL_MERGE_WINDOW_MS`. The reported row therefore sits on the boundary,
and the boundary is inclusive: a `<` comparison would leave the confirmation
standing as a third entry and no other assertion in the suite would notice.
`21:48:04.000 → 21:48:06.000` is 2,000 ms, inside the window, and the two
questions still do NOT fold — they are different questions, which is what the
identity test is for.

## The limit of the heuristic

**`chat_messages` stores no id for a question set.** Nothing in `promptData` ties
the confirmation row to the questions it confirms: `askUserQuestion`
(Issue #1726) carries `questionIndex` / `questionCount`, and it is absent from
the confirmation row entirely, because the structured payload describes the
questions and not the submit screen.

So the tie is reconstructed from three pieces of evidence, all of which can be
absent:

1. the confirmation's review lists the question's text, character for character
   after normalization;
2. both rows are in one pane (worktree + resolved instance + CLI tool) and in one
   uninterrupted run of `prompt` rows in the SAVED order;
3. the confirmation lands 0–5,000 ms after the question's first row.

When any of them is missing — the questions were never loaded into the column,
the review was reworded, the clock is unreadable, a reply or a permission dialog
landed between them — the confirmation stays a chip of its own and is counted as
a submit confirmation rather than as a question. That is the intended failure
direction: a loose confirmation is a visible extra line, while a wrong fold would
silently attach one question set's submission to another's.
