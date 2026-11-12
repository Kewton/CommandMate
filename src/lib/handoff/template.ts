/**
 * The fixed text the screen sends the agent to ask for its hand-off (Issue #4227,
 * design `mem-ui-4227.md` §4.2). No model is asked (D1): only the request's id and
 * its deadline are put in, inside the bracketed header (D12's data framing).
 *
 * G9: every `commandmate …` command of this text is parsed by the real CLI program in
 * `tests/unit/cli/commands/handoff-template-parse-4227.test.ts` (a line added here is checked too).
 *
 * G9 (PR4): the `--close-when` rule per kind (required or not, the types taken) is built from
 * `lib/mem/close-when` (`CLOSE_WHEN_DEFAULTS` / `CLOSE_WHEN_ALLOWED` / `CLOSE_WHEN_TYPES`), not copied;
 * each kind's example is run through the CLI and `parseCloseWhen` in
 * `tests/unit/cli/commands/handoff-template-close-when-4227.test.ts`. Times are written `+09:00`.
 * Which kinds require it is said by the one generated line of `./close-when-kinds` (g9f), the same
 * text the CLI's help and the guides carry; no list of kinds is written here.
 *
 * @module lib/handoff/template
 */

import { CLOSE_WHEN_ALLOWED, CLOSE_WHEN_DEFAULTS, CLOSE_WHEN_TYPES } from '@/lib/mem/close-when';
import { MEM_EXIT_BY_CODE, MEM_KINDS, type MemCloseWhenType, type MemKind } from '@/types/mem';
import { closeWhenKindsText } from './close-when-kinds';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-11-10T09:05:00+09:00`: the form `at:` takes, and the one an agent reads without mistaking the hour. */
function jstIso(date: Date): string {
  return `${new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

/** How each `--close-when` type is written. Typed over every type: a type added to the grammar fails to compile here. */
export const CLOSE_WHEN_FORMS: Readonly<Record<MemCloseWhenType, string>> = {
  replaced: 'replaced',
  manual: 'manual',
  issue: 'issue:#<n>',
  pr: 'pr:#<n>',
  branch: 'branch:<name>?merged=<into>',
  relay: 'relay:<id>',
  worktree: 'worktree:<id>',
  session: 'session:task:<id>',
  at: 'at:<ISO8601+09:00>',
};

type ProposeKind = Exclude<MemKind, 'now'>;

/**
 * The type each kind's example uses, chosen for what the kind means: `at:` closes the item by itself at that
 * time, so only a kind that is "until a time" would use it. Typed over the kinds: a kind added fails to compile.
 */
const EXAMPLE_TYPE: Readonly<Record<ProposeKind, MemCloseWhenType>> = {
  waiting: 'pr',
  decision: 'issue',
  next: 'manual',
  external: 'manual',
  note: 'manual',
};

/** The kinds a hand-off can propose (`now` is the agent's own, not proposed here). */
const PROPOSE_KINDS = MEM_KINDS.filter((kind): kind is ProposeKind => kind !== 'now');

function exampleFor(kind: ProposeKind): string {
  return CLOSE_WHEN_FORMS[EXAMPLE_TYPE[kind]];
}

function kindLines(): string[] {
  const { required } = closeWhenKindsText();
  return PROPOSE_KINDS.map((kind) => {
    const fallback = CLOSE_WHEN_DEFAULTS[kind];
    const rule =
      required.includes(kind)
        ? `--close-when は必須（付けないと propose は終了コード ${MEM_EXIT_BY_CODE.invalid_close_when}）`
        : `--close-when は省略可（省略すると ${fallback === 'promoted' ? '決定の既定' : fallback}）`;
    const types = [...CLOSE_WHEN_TYPES].filter((type) => CLOSE_WHEN_ALLOWED[kind].has(type));
    return `- kind=${kind}: ${rule}。使える値: ${types.join(' / ')}。例: --close-when ${exampleFor(kind)}`;
  });
}

function formsLine(deadline: Date): string {
  const taken = [...CLOSE_WHEN_TYPES].filter((type) => PROPOSE_KINDS.some((kind) => CLOSE_WHEN_ALLOWED[kind].has(type)));
  const at = jstIso(new Date(deadline.getTime() + DAY_MS));
  return `- --close-when の値の形: ${taken.map((type) => CLOSE_WHEN_FORMS[type]).join(' / ')}（<…> は埋める。at: はその時刻に自動で閉じる。時刻は +09:00 の形で、例 at:${at}）`;
}

export function handoffRequestText(requestId: string, deadline: Date): string {
  return [
    `[CommandMate: 終了の前の引き継ぎの依頼 request=${requestId} 期限=${jstIso(deadline)}]`,
    'このセッションを終える前に、mem の更新を「提案」として出してください。確定は人が画面で行います。',
    `- 追加:  commandmate handoff propose --request ${requestId} add --kind <kind> --text "…" --close-when <cond>`,
    closeWhenKindsText().ja,
    ...kindLines(),
    formsLine(deadline),
    `- 更新:  commandmate handoff propose --request ${requestId} update <itemId> --base-version <v> --text "…"`,
    `- close: commandmate handoff propose --request ${requestId} close <itemId> --base-version <v> [--reason "…"]`,
    `- 終わったら: commandmate handoff done --request ${requestId}`,
    'propose が失敗したら（終了コードが 0 以外）、done の前に直して出し直してください。done の後の提案は受け付けません。propose と done を 1 つのコマンドにつながないでください。',
    '今の項目は commandmate mem list で読めます。mem add / update / close で直接確定しないでください。',
  ].join('\n');
}
