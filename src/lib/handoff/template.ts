/**
 * The fixed text the screen sends the agent to ask for its hand-off (Issue #4227,
 * design `mem-ui-4227.md` §4.2). No model is asked (D1): only the request's id and
 * its deadline are put in, inside the bracketed header (D12's data framing).
 *
 * G9: every `commandmate …` command of this text is parsed by the real CLI program in
 * `tests/unit/cli/commands/handoff-template-parse-4227.test.ts` (a line added here is checked too).
 *
 * @module lib/handoff/template
 */

export function handoffRequestText(requestId: string, deadline: Date): string {
  return [
    `[CommandMate: 終了の前の引き継ぎの依頼 request=${requestId} 期限=${deadline.toISOString()}]`,
    'このセッションを終える前に、mem の更新を「提案」として出してください。確定は人が画面で行います。',
    `- 追加:  commandmate handoff propose --request ${requestId} add --kind <kind> --text "…" [--close-when …]`,
    `- 更新:  commandmate handoff propose --request ${requestId} update <itemId> --base-version <v> --text "…"`,
    `- close: commandmate handoff propose --request ${requestId} close <itemId> --base-version <v> [--reason "…"]`,
    `- 終わったら: commandmate handoff done --request ${requestId}`,
    'propose が失敗したら（終了コードが 0 以外）、done の前に直して出し直してください。done の後の提案は受け付けません。propose と done を 1 つのコマンドにつながないでください。',
    '今の項目は commandmate mem list で読めます。mem add / update / close で直接確定しないでください。',
  ].join('\n');
}
