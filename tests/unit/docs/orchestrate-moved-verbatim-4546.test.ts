/**
 * Text moved out of docs/orchestrate/team.md is moved verbatim (Issue #4546 PR-4).
 *
 * #4546 shrinks team.md to 24,000 bytes by moving the body of some rules (the
 * procedure and detail after a rule's bold title) to the operations documents,
 * leaving the title and a pointer. An earlier attempt reworded the moved text
 * four times. This pins the move so that no sentence of a rule is rewritten:
 *
 * - V1: each registered text is a line of its destination, exactly once, inside
 *   the registered heading's section (whole-line match on `split('\n')`).
 * - V2: each registered text is gone from team.md, and the original line's head
 *   (`N. **題。** `, `- ` or nothing) stays with a pointer (`本文: [..](file#anchor)`).
 * - V3: every line of team.md is (a) a line of team.md at develop dbc5e96f2 (the
 *   commit before the move), (b) a pointer whose head is the head of an original
 *   line whose rest is a registered text, the link naming that text's destination
 *   and heading, or (c) a line of ALLOWED_NEW, each with its reason.
 * - V4: the `<file>#<anchor>` of each pointer is an existing heading of that file
 *   (GitHub's rule, from orchestrate-doc-links-3481).
 * - V5: no original line is lost: each line of ORIGINAL_LINE_HASHES is a line of
 *   team.md today, or a pointer line of team.md keeps its head and a registered text
 *   is the rest (original line = head + MOVED text). V3 alone passes when a line is
 *   only deleted.
 *
 * The original lines are held as hashes (ORIGINAL_LINE_HASHES): CI checks out one
 * commit, so `git show dbc5e96f2:…` is not available there. The table and the texts
 * were generated from `git show dbc5e96f2:docs/orchestrate/team.md`, not typed.
 *
 * To change team.md on purpose after this move (a new rule, a reworded line), rebuild
 * ORIGINAL_LINE_HASHES from today's develop team.md with this one line, and paste its
 * output into the set:
 *   git show origin/develop:docs/orchestrate/team.md | node -e "const c=require('crypto');const l=require('fs').readFileSync(0,'utf8').split('\n');console.log([...new Set(l)].map((x)=>\"  '\"+c.createHash('sha256').update(x).digest('hex').slice(0,16)+\"',\").sort().join('\n'))"
 * After the rebuild, MOVED and ALLOWED_NEW may be empty (the lines are originals
 * again; the test that pins MOVED's 14 items is changed with it).
 *
 * The controls run on a temporary directory; the real files are only read.
 *
 * @vitest-environment node
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { githubSlug, headingAnchors } from './orchestrate-doc-links-3481.test';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TEAM_RELATIVE_PATH = 'docs/orchestrate/team.md';

export interface Moved {
  /** Where the text was in team.md at dbc5e96f2. */
  from: string;
  /** The rest of the original line after its head, verbatim. */
  text: string;
  /** The destination, from the repository root. */
  to: string;
  /** The destination heading, without the `#`s. */
  heading: string;
}

export interface Registry {
  originals: ReadonlySet<string>;
  moved: ReadonlyArray<Moved>;
  allowedNew: ReadonlyArray<{ line: string; why: string }>;
}

/** The short hash ORIGINAL_LINE_HASHES holds for one line. */
export const lineHash = (line: string): string =>
  crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);

/** A pointer line: the original head, then `本文: [label](file#anchor)` and nothing else. */
const POINTER = /^(.*?)本文: \[[^\]]+\]\(([^)#\s]+)#([^)\s]+)\)$/;
/** The heads a pointer may keep: nothing, a bullet, or a numbered item with its bold title. */
const HEAD = /^(?:|- |\d+\. \*\*.+)$/;

/** The lines of the section under `heading` (to the next heading of the same or a higher level). */
export function sectionLines(markdown: string, heading: string): string[] | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && l.replace(/^#{1,6} /, '') === heading);
  if (start === -1) return undefined;
  const level = /^#+/.exec(lines[start])?.[0].length ?? 0;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#{1,6}) /.exec(l);
    return m !== null && m[1].length <= level;
  });
  return end === -1 ? rest : rest.slice(0, end);
}

/** V1: `<from>: <why>` for each text that is not a line of its destination section exactly once. */
export function notInDestination(moved: ReadonlyArray<Moved>, read: (rel: string) => string | undefined): string[] {
  const problems: string[] = [];
  for (const m of moved) {
    const doc = read(m.to);
    if (doc === undefined) {
      problems.push(`${m.from}: ${m.to} does not exist`);
      continue;
    }
    const section = sectionLines(doc, m.heading);
    if (section === undefined) {
      problems.push(`${m.from}: ${m.to} has no heading "${m.heading}"`);
      continue;
    }
    const count = section.filter((l) => l === m.text).length;
    if (count !== 1) problems.push(`${m.from}: ${count} lines in ${m.to} "${m.heading}" (expected 1): ${m.text.slice(0, 40)}`);
  }
  return problems;
}

const pointerFor = (m: Moved, file: string, anchor: string): boolean =>
  path.basename(m.to) === file && githubSlug(m.heading) === anchor;

/** V2: each text is gone from team.md, and team.md keeps the original head with a pointer to it. */
export function stillInTeam(team: string, registry: Registry): string[] {
  const problems: string[] = [];
  const lines = team.split('\n');
  for (const m of registry.moved) {
    if (team.includes(m.text)) problems.push(`${m.from}: still in team.md: ${m.text.slice(0, 40)}`);
    const kept = lines.some((l) => {
      const p = POINTER.exec(l);
      return p !== null && registry.originals.has(lineHash(p[1] + m.text)) && pointerFor(m, p[2], p[3]);
    });
    if (!kept) problems.push(`${m.from}: no pointer in team.md keeps the original head and points at ${m.to}#${githubSlug(m.heading)}`);
  }
  return problems;
}

/** V3: `team.md:<n>: <line>` for each line that is not original, a pointer of the registry, or allowed. */
export function unknownTeamLines(team: string, registry: Registry): string[] {
  const allowed = new Set(registry.allowedNew.map((a) => a.line));
  const problems: string[] = [];
  team.split('\n').forEach((line, i) => {
    if (registry.originals.has(lineHash(line)) || allowed.has(line)) return;
    const p = POINTER.exec(line);
    if (
      p !== null &&
      HEAD.test(p[1]) &&
      registry.moved.some((m) => registry.originals.has(lineHash(p[1] + m.text)) && pointerFor(m, p[2], p[3]))
    ) {
      return;
    }
    problems.push(`team.md:${i + 1}: ${line.slice(0, 60)}`);
  });
  return problems;
}

/** V4: `team.md:<n>: <file>#<anchor>` for each pointer whose file or heading does not exist. */
export function brokenPointers(team: string, read: (rel: string) => string | undefined): string[] {
  const problems: string[] = [];
  team.split('\n').forEach((line, i) => {
    const p = POINTER.exec(line);
    if (p === null) return;
    const doc = read(path.posix.join(path.posix.dirname(TEAM_RELATIVE_PATH), p[2]));
    if (doc === undefined || !headingAnchors(doc).has(p[3])) problems.push(`team.md:${i + 1}: ${p[2]}#${p[3]}`);
  });
  return problems;
}

/** V5: `original <hash>: …` for each original line that is neither in team.md nor a head + moved text of a pointer. */
export function lostOriginals(team: string, registry: Registry): string[] {
  const kept = new Set<string>();
  for (const line of team.split('\n')) {
    kept.add(lineHash(line));
    const p = POINTER.exec(line);
    if (p === null) continue;
    for (const m of registry.moved) if (pointerFor(m, p[2], p[3])) kept.add(lineHash(p[1] + m.text));
  }
  return [...registry.originals]
    .filter((h) => !kept.has(h))
    .map((h) => `original ${h}: not in team.md, and no pointer keeps it as head + a moved text`);
}

/** A reader of repository-relative paths under `root`; undefined when the file is missing. */
export function readerAt(root: string): (rel: string) => string | undefined {
  return (rel) => {
    const abs = path.join(root, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
  };
}

/** All four checks for the repository (or a copy of it) under `root`. */
export function checkMoved(root: string, registry: Registry): Record<'v1' | 'v2' | 'v3' | 'v4' | 'v5', string[]> {
  const read = readerAt(root);
  const team = read(TEAM_RELATIVE_PATH);
  if (team === undefined) throw new Error(`${TEAM_RELATIVE_PATH} not found under ${root}`);
  return {
    v1: notInDestination(registry.moved, read),
    v2: stillInTeam(team, registry),
    v3: unknownTeamLines(team, registry),
    v4: brokenPointers(team, read),
    v5: lostOriginals(team, registry),
  };
}

// ---------------------------------------------------------------------------
// The registry (generated from `git show dbc5e96f2:docs/orchestrate/team.md`)
// ---------------------------------------------------------------------------

/** T18, verbatim from e3476c112's team.md. */
export const T18_LINE =
  "ロールの正本（`docs/orchestrate/roles/*.md`）の正はこのリポジトリ。ロールの本文を変えた後と、セッションを起動する前に `node scripts/orchestrate/roles-sync.mjs check` を流す。`differs` のときは黙って `roles edit --file` で巻き戻さず、PM へ返す（PM が人へ）。";

/**
 * New lines of team.md, each with why it is allowed. Only T18 (the person's
 * decision on #4546): the line is the one of e3476c112's team.md that starts
 * with `ロールの正本（`, verbatim.
 */
export const ALLOWED_NEW: ReadonlyArray<{ line: string; why: string }> = [
  {
    line: T18_LINE,
    why: 'T18: ロールの正本の正・roles-sync check の時期・differs で巻き戻さず PM へ（e3476c112 の team.md の行を一字一句。§1 の claude-3 の行の後）',
  },
];

export const MOVED: ReadonlyArray<Moved> = [
  {
    from: "team.md §6-8",
    text: "「次のレビューで指摘が出なければ」という条件つきの最短を予測として伝えない。残りの往復の見込み（台帳と整合性レビューの記録から）× 1 往復の時間（verify の待ち＋実行＋レビュー）で幅を出し、最短と見込みを分けて書く。分かっている制約（夜の計測・期限・1 人のリーダーを通る直列・CI の不安定）は最初から入れる。見通しを変えたら、何が外れたかを 1 行添える。なぜ: 条件が外れるたびに終わりが延び、後ろ倒しに見えた",
    to: "docs/orchestrate/verify-queue.md",
    heading: "見通しを実績の率で幅を出す",
  },
  {
    from: "team.md §6-10",
    text: "対象は易・局所（1〜2 ファイル）で、2 の 5 つ（送信の経路と relay・ロック・データ（migration・DB の書き込み）・公開の API と CLI の契約・ゲートと検証の定義）に触れないもの。流れは設計の段を省き、Command Code のワーカー → レビュー 1 本 → verify（ゲートは 1 つも変えない）→ CI 全件 success → `--last`。受け入れはリリース前のまとめで拾う。迷ったら通常の流れ（高リスクの規則）に戻す。速い道にした Issue は返しに「速い道」と書く",
    to: "docs/orchestrate/difficulty.md",
    heading: "1-2b 易しい bug の速い道",
  },
  {
    from: "team.md §7 の 2 つ目の項目",
    text: "作る速さがマージの速さを超えると、開いた PR が溜まり、CI 1 回が長くなって、さらにマージが遅れる。PM は返しを待つだけでなく、定期的に「直近 1 時間のマージ数・開いた PR 数・ランナーの online 数・queued の最古」を見る。online 0 か queued 10 分超なら、ランナーの健康を先に確かめる（docs/orchestrate/ci-merge.md の「6-3 CI が queued のまま進まないとき」）",
    to: "docs/orchestrate/ci-merge.md",
    heading: "6-3 マージの流れを定期的に見る",
  },
  {
    from: "team.md §8",
    text: "- 依頼（ワーカー・イネーブラー・CI・レビュー）を送ったら、同じ手番で期限の無い完了の見張りを張り、返しが出たら終わる待ちにする。期限で切れる見張りを張り直す運用にしない。返しは 2 種類ある:",
    to: "docs/orchestrate/workers.md",
    heading: "3-2 返しの形と見張りが起きるとき",
  },
  {
    from: "team.md §8",
    text: "  - (1) **ワーカーの task の返しの行**: 契約の goal と同じ形 `DONE: #<N> <sha> verify exit <n>` / `WAIT: <理由>` / `STOP: <理由>`。行全体がこの形で、DONE の `<sha>` は今の HEAD を名指す。見張り（`orchestrate-monitor`）が拾うのはこの形だけ",
    to: "docs/orchestrate/workers.md",
    heading: "3-2 返しの形と見張りが起きるとき",
  },
  {
    from: "team.md §8",
    text: "  - (2) **イネーブラー・CI・レビューの返し**: 返しのファイルの `DONE:` 行（例 `DONE: changes-required P1=1 P2=1 P3=6`）。形は依頼文で決める。(1) の形ではないので、見張りの返しの行としては拾わない。返しのファイルか、依頼文で決めた形で待つ",
    to: "docs/orchestrate/workers.md",
    heading: "3-2 返しの形と見張りが起きるとき",
  },
  {
    from: "team.md §8",
    text: "- 見張りが起きるのは 3 つ: (a) 返しの行、(b) 許可のプロンプト（画面が確認待ちで止まった）、(c) 新しいコミット。(b)(c) では終わらせず、人に返すか次の手を決める。`IMPL_COMPLETED` は**形の外の終わり方**で、見張りは `SHAPE_OUTSIDE` として知らせ、合格には数えない（#4532 より前に送った task のための古い合図で、待ちを終わらせる形ではない）",
    to: "docs/orchestrate/workers.md",
    heading: "3-2 返しの形と見張りが起きるとき",
  },
  {
    from: "team.md §8",
    text: "- 読み方の細部: [workers.md](workers.md#3-2-完了の見張りが-pane-を読む細部)。画面が長く変わらなければ STALL として知らせる。依頼文の締めに「止まるときも `STOP: <理由>` と書く」を必ず入れる",
    to: "docs/orchestrate/workers.md",
    heading: "3-2 返しの形と見張りが起きるとき",
  },
  {
    from: "team.md §8",
    text: "- 見張りの除外の規則を自作しない（雛形どおりに書いた本物の `DONE:` 行まで除いてしまう）。(1) の形は goal が決め、見張りはその形で絞る。(2) の形は依頼文で決める。見張りを張ったら、`DONE:` が既にある画面で一度鳴ることを確かめる",
    to: "docs/orchestrate/workers.md",
    heading: "3-2 返しの形と見張りが起きるとき",
  },
  {
    from: "team.md §8",
    text: "- CI は `bucket` が全部終わるまでを待ち、10 分以上 queued ならランナーが online かも見る。動いている依頼と見張りの一覧をいつでも出せるようにしておく",
    to: "docs/orchestrate/workers.md",
    heading: "3-2 返しの形と見張りが起きるとき",
  },
  {
    from: "team.md §9 の「受け入れ・リリースの間のマージ」",
    text: "判定する版を決めるのは PM。**受け入れ・リリースの間も develop へのマージは続ける**（人の決定、mem c31afe28）。止めるのは、**main への PR を作ってから、マージバック（main の変更を develop へ戻すマージ）が済むまで**だけで、PM が「停止」「再開」を全リーダーへ 1 行で知らせる。止めている間もレビュー・直し・verify は続けてよい。判定する版（commit）は固定し、その後に develop へ入ったものは次の受け入れの対象になる。関門は変えない（根拠は ci-merge.md の 6-2-1）。",
    to: "docs/orchestrate/ci-merge.md",
    heading: "6-2-1 受け入れ・リリースの間の develop へのマージ",
  },
  {
    from: "team.md §10-2",
    text: "一覧は [multi-lead.md](multi-lead.md#境界のファイル)。持ち主でないリーダーのワーカーは書かない。changelog は Issue ごとの断片なので持ち分の対象にしない。API を変える Issue と、それを呼ぶ画面の Issue は同じリーダーの同じ PR にするか、API を先にマージする直列にする。もう 1 人のリーダーの未マージのブランチの上でブランチを切らない（土台のマージの後に develop から切る）",
    to: "docs/orchestrate/multi-lead.md",
    heading: "境界のファイル",
  },
  {
    from: "team.md §10-3",
    text: "マージは各リーダーが自分の PR を自分で流す（ロックの先着順に任せ、待ち合わせのシェルを自作しない）。**積み直し（develop の取り込み・衝突の解消・precheck・merge-pr の exit 4 の再実行）の持ち主は、後からマージする PR のリーダー**。衝突の解消で相手の持ち分のファイルの意味を変える必要があれば、解消せずに止めて PM に返す。統合破壊は後からマージした側が直す。マージのたびに develop の push CI の結論を見て、赤なら 2 人とも次のマージを止める。「CI が通れば」の許可の run では全 PR に `--last` を付ける。列（`--queue`）には条件がそろった PR だけを 1 回に 2〜3 本まで入れる",
    to: "docs/orchestrate/multi-lead.md",
    heading: "マージの順と積み直し",
  },
  {
    from: "team.md §10-6",
    text: "片方のリーダーで 1 回目が出た種類は、もう片方の依頼文にも最初から不変条件として書く（2 人で数えを共有する）。2 回目は直しを送らず STOP で PM に返す",
    to: "docs/orchestrate/multi-lead.md",
    heading: "同じ種類の指摘の一覧",
  },
];

export const ORIGINAL_LINE_HASHES: ReadonlySet<string> = new Set([
  '01f5c6f6adb0d808',
  '025e6851b1d4ff4a',
  '031cbee4f6dafc08',
  '049bd64b5b77b258',
  '057f9f9a2e11ffac',
  '088071e45d06d6ec',
  '0d1794aeb222deda',
  '0fea481af4a6c753',
  '0ffb74dd2fc9adc1',
  '13034871cf0d8ff1',
  '186cd950cc988e86',
  '199e8e18a18e3d21',
  '1ac96ec0822cd300',
  '1b3ae2d93cdb0e8d',
  '1e294675e70e8a21',
  '1eb32014560852a7',
  '203142c1992f6bb7',
  '2082f2d77be2702b',
  '22dc7bb2842c3991',
  '23276de9924534fb',
  '29a7221447337331',
  '29f658ef03454f8c',
  '2ecd6609592d4b8b',
  '2ece8f52e2f77e10',
  '30a8afea569ef409',
  '349678c3d0ab2301',
  '34f873ed1960417c',
  '34fdf1b815a005ee',
  '350ccc4e13504719',
  '3733716f42587e76',
  '38ac780d875369ae',
  '43c70bd4c55c5f51',
  '43d1dd1a4bc6ed00',
  '495d5f69c09fa462',
  '49f4422185b78205',
  '4a719d5381246de0',
  '4da1ec6f47782090',
  '4ef30205068390fc',
  '501b86dd9038db43',
  '55ad8a6877cebb6d',
  '590ec9243b851b8b',
  '5a816ab78d3f1c00',
  '5a8c7c705e55430a',
  '5da34d8835b7ed3f',
  '607f3d7438aa4cec',
  '628b352d9f93c490',
  '6370705c0758c04f',
  '64e729183258d44f',
  '658a1fcaf58747e6',
  '672ddd0d3e376d5f',
  '69eb9211d85d6b93',
  '6bf9973c186af566',
  '7161da6df9dd7470',
  '7446775e2cc6b67e',
  '7593de27a13a546b',
  '798cbb1a3cf4847c',
  '7ac43a154c6640c8',
  '7cf9212b0de2dbb8',
  '7d02ef85f9a9aee1',
  '87a918e32032dfa1',
  '88943f85b6288b74',
  '8ae4f100f8308f3a',
  '8e0eb43d5412dc8f',
  '8f49059e4daf3f13',
  '8fb3b96b2e8f5deb',
  '90d7ce002b926b16',
  '916fad9613959dea',
  '9265c78fcb1077fe',
  '92b2f5d8bf1aad82',
  '9732e5bcf82dc756',
  '9930e786c37ead42',
  '9b8379e96b545538',
  '9dafc4ca8850d3e7',
  'a41a1154243e477b',
  'a4b2ab681f07e1f1',
  'a6dc15998da025b9',
  'aa073b818744b5d8',
  'ab420fa621404da3',
  'b153cbd44f52ca38',
  'b57d2195df782c60',
  'b77b04d9740980b5',
  'bc1e1507ba0df158',
  'bf73092027102b92',
  'c54fbbcfbdc500cf',
  'c87820e65d2feabc',
  'c921886016224153',
  'cbbff5d01363954c',
  'cedf4cda98511e03',
  'cfdcb24be80e116e',
  'd328705468d42a34',
  'd85244a9488abef2',
  'dbaa86394f9df693',
  'dbebb7bdb7df1c46',
  'de0fbc37fda0d04a',
  'de3606f4de542e4c',
  'de92f9e00ee085e6',
  'deebbed8a2765188',
  'e0a8c775d419b664',
  'e1a2156674b9f5ea',
  'e1a9b3d8022c572c',
  'e3b0c44298fc1c14',
  'e7ec4310ca76bea1',
  'e7f67da13fe2e589',
  'eb816e9078a82c28',
  'edd43e456d239f38',
  'ede89d0c54ac87b9',
  'ef55b90a240994a8',
  'f1fd211bb054a12e',
  'f235b9cc15f0d87b',
  'f3f12bdca2afb88f',
  'f639f840b68dd646',
  'f674749aa5032a67',
  'f7e132dbff26e733',
]);

const REGISTRY: Registry = { originals: ORIGINAL_LINE_HASHES, moved: MOVED, allowedNew: ALLOWED_NEW };

// ---------------------------------------------------------------------------
// Controls (a temporary directory; the repository is not written)
// ---------------------------------------------------------------------------

const FIXTURE_ORIGINAL = ['# T', '', '## 6. 節', '', '1. **題。** 移す文。', '- 残す項目', '- 移す項目の文', ''];
const FIXTURE_MOVED: Moved[] = [
  { from: 'f §6-1', text: '移す文。', to: 'docs/orchestrate/a.md', heading: '1-1 移した節' },
  { from: 'f §6 の 2 つ目', text: '移す項目の文', to: 'docs/orchestrate/a.md', heading: '1-1 移した節' },
];
const FIXTURE_NEW = '足してよい行。';
const FIXTURE_REGISTRY: Registry = {
  originals: new Set(FIXTURE_ORIGINAL.map(lineHash)),
  moved: FIXTURE_MOVED,
  allowedNew: [{ line: FIXTURE_NEW, why: 'fixture' }],
};
const FIXTURE_TEAM = [
  '# T',
  '',
  FIXTURE_NEW,
  '',
  '## 6. 節',
  '',
  '1. **題。** 本文: [a.md](a.md#1-1-移した節)',
  '- 残す項目',
  '- 本文: [a.md 1-1](a.md#1-1-移した節)',
  '',
].join('\n');
const FIXTURE_DEST = ['# A', '', '## 1-1 移した節', '', '元の場所: …', '', '移す文。', '移す項目の文', '', '## 次の節', '', '移す文。', ''].join(
  '\n',
);

describe('moved verbatim: controls (#4546)', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const rootWith = (team: string, dest?: string): string => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-moved-verbatim-'));
    fs.mkdirSync(path.join(root, 'docs/orchestrate'), { recursive: true });
    fs.writeFileSync(path.join(root, TEAM_RELATIVE_PATH), team);
    if (dest !== undefined) fs.writeFileSync(path.join(root, 'docs/orchestrate/a.md'), dest);
    return root;
  };
  const none = { v1: [], v2: [], v3: [], v4: [], v5: [] };

  it('positive: the original team.md with nothing registered passes', () => {
    const registry = { ...FIXTURE_REGISTRY, moved: [] };
    expect(checkMoved(rootWith(FIXTURE_ORIGINAL.join('\n')), registry)).toEqual(none);
  });

  it('positive: a verbatim move with the original heads and pointers passes', () => {
    expect(checkMoved(rootWith(FIXTURE_TEAM, FIXTURE_DEST), FIXTURE_REGISTRY)).toEqual(none);
  });

  it('negative (V1): one character changed in the destination is reported', () => {
    const result = checkMoved(rootWith(FIXTURE_TEAM, FIXTURE_DEST.replace('移す項目の文', '移す項目の分')), FIXTURE_REGISTRY);
    expect(result.v1).toEqual(['f §6 の 2 つ目: 0 lines in docs/orchestrate/a.md "1-1 移した節" (expected 1): 移す項目の文']);
    expect([result.v2, result.v3, result.v4]).toEqual([[], [], []]);
  });

  it('negative (V1): the text only under another heading, or twice, is reported', () => {
    const moved = FIXTURE_DEST.replace('\n移す文。\n移す項目の文', '\n移す項目の文');
    expect(checkMoved(rootWith(FIXTURE_TEAM, moved), FIXTURE_REGISTRY).v1).toEqual([
      'f §6-1: 0 lines in docs/orchestrate/a.md "1-1 移した節" (expected 1): 移す文。',
    ]);
    const twice = FIXTURE_DEST.replace('移す項目の文', '移す項目の文\n移す項目の文');
    expect(checkMoved(rootWith(FIXTURE_TEAM, twice), FIXTURE_REGISTRY).v1).toEqual([
      'f §6 の 2 つ目: 2 lines in docs/orchestrate/a.md "1-1 移した節" (expected 1): 移す項目の文',
    ]);
  });

  it('negative (V2): the original text left in team.md is reported', () => {
    const team = FIXTURE_TEAM.replace('- 残す項目', '- 残す項目\n- 移す項目の文');
    const result = checkMoved(rootWith(team, FIXTURE_DEST), FIXTURE_REGISTRY);
    expect(result.v2).toEqual(['f §6 の 2 つ目: still in team.md: 移す項目の文']);
    expect([result.v1, result.v3, result.v4]).toEqual([[], [], []]);
  });

  it('negative (V2): a moved text whose pointer is gone is reported', () => {
    const team = FIXTURE_TEAM.replace('- 本文: [a.md 1-1](a.md#1-1-移した節)\n', '');
    expect(checkMoved(rootWith(team, FIXTURE_DEST), FIXTURE_REGISTRY).v2).toEqual([
      'f §6 の 2 つ目: no pointer in team.md keeps the original head and points at docs/orchestrate/a.md#1-1-移した節',
    ]);
  });

  it('negative (V3): a reworded line of team.md, and a pointer with a reworded head, are reported', () => {
    const team = FIXTURE_TEAM.replace('- 残す項目', '- 残す項目（言い換え）').replace('1. **題。** 本文', '1. **題を変えた。** 本文');
    const result = checkMoved(rootWith(team, FIXTURE_DEST), FIXTURE_REGISTRY);
    expect(result.v3).toEqual(['team.md:7: 1. **題を変えた。** 本文: [a.md](a.md#1-1-移した節)', 'team.md:8: - 残す項目（言い換え）']);
    expect(result.v1).toEqual([]);
    expect(result.v4).toEqual([]);
  });

  it('negative (V3): a pointer to a destination other than the registered one is reported', () => {
    const team = FIXTURE_TEAM.replace('1. **題。** 本文: [a.md](a.md#1-1-移した節)', '1. **題。** 本文: [a.md](a.md#次の節)');
    expect(checkMoved(rootWith(team, FIXTURE_DEST), FIXTURE_REGISTRY).v3).toEqual([
      'team.md:7: 1. **題。** 本文: [a.md](a.md#次の節)',
    ]);
  });

  it('negative (V4): a pointer whose heading was removed is reported', () => {
    const result = checkMoved(rootWith(FIXTURE_TEAM, FIXTURE_DEST.replace('## 1-1 移した節', '1-1 移した節')), FIXTURE_REGISTRY);
    expect(result.v4).toEqual(['team.md:7: a.md#1-1-移した節', 'team.md:9: a.md#1-1-移した節']);
    expect(result.v3).toEqual([]);
  });

  it('negative (V1・V4): a missing destination file is reported, not passed', () => {
    const result = checkMoved(rootWith(FIXTURE_TEAM), FIXTURE_REGISTRY);
    expect(result.v1).toHaveLength(2);
    expect(result.v4).toHaveLength(2);
  });

  it('negative (V5): an original line only deleted from team.md is reported (V3 does not see it)', () => {
    const result = checkMoved(rootWith(FIXTURE_TEAM.replace('- 残す項目\n', ''), FIXTURE_DEST), FIXTURE_REGISTRY);
    expect(result.v5).toEqual([
      `original ${lineHash('- 残す項目')}: not in team.md, and no pointer keeps it as head + a moved text`,
    ]);
    expect([result.v1, result.v2, result.v3, result.v4]).toEqual([[], [], [], []]);
  });

  it('negative (V5): §6 の 9 deleted from a copy of the real team.md is reported', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-moved-verbatim-'));
    fs.mkdirSync(path.join(root, 'docs/orchestrate'), { recursive: true });
    const real = fs.readFileSync(path.join(REPO_ROOT, TEAM_RELATIVE_PATH), 'utf8');
    const nine = real.split('\n').find((l) => l.startsWith('9. **'));
    expect(nine).toBeDefined();
    fs.writeFileSync(path.join(root, TEAM_RELATIVE_PATH), real.replace(`${nine}\n`, ''));
    expect(checkMoved(root, REGISTRY).v5).toEqual([
      `original ${lineHash(nine as string)}: not in team.md, and no pointer keeps it as head + a moved text`,
    ]);
  });

  it('throws when team.md is missing instead of passing', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-moved-verbatim-'));
    expect(() => checkMoved(root as string, FIXTURE_REGISTRY)).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// The real files
// ---------------------------------------------------------------------------

describe('moved verbatim: this repository (#4546)', () => {
  const result = checkMoved(REPO_ROOT, REGISTRY);

  it('has the registry (anti-vacuity)', () => {
    expect(MOVED).toHaveLength(14);
    expect(ORIGINAL_LINE_HASHES.size).toBeGreaterThanOrEqual(100);
    for (const a of ALLOWED_NEW) expect(a.line).toBe(T18_LINE);
    for (const a of ALLOWED_NEW) expect(ORIGINAL_LINE_HASHES.has(lineHash(a.line))).toBe(false);
  });

  it('V1: every moved text is a line of its destination section, exactly once', () => {
    expect(result.v1).toEqual([]);
  });

  it('V2: every moved text is gone from team.md, which keeps the original head and a pointer', () => {
    expect(result.v2).toEqual([]);
  });

  it('V3: every line of team.md is original, a registered pointer, or allowed', () => {
    expect(result.v3).toEqual([]);
  });

  it('V4: every pointer of team.md names an existing heading', () => {
    expect(result.v4).toEqual([]);
  });

  it('V5: no original line of team.md is lost (kept, or head + moved text behind a pointer)', () => {
    expect(result.v5).toEqual([]);
  });
});
