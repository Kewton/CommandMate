/**
 * `docs/design/multi-agent-state-architecture.md` may not name code that is not
 * there (Issue #1995).
 *
 * ## What happened
 *
 * The document is the 正本 that Epic #1921's implementation Issues are written
 * from (#1915). Two of its references had gone stale without anyone noticing:
 *
 *  - #1900 renamed `readOpencodeEventStream` to `openOpencodeEventStream`.
 *    §4 D3, §6.2, §10.4 and §13.2 S4 kept the old name for three weeks.
 *  - #1933 deleted `getStatusCaptureLines` outright, folding it into
 *    `captureSpec()`. Four sections kept asking a future Phase 3 to do the
 *    migration that had already landed, including a `- [ ]` in §13.
 *
 * Both cost the same way: a worker sent to the document either stops at "I
 * cannot find it" or builds a second thing beside the real one. The #1995 sweep
 * found five more of the same shape (`StatusVerdict`, `findOnPath`,
 * `deliverVerdict`, `CLITool`, `src/lib/__tests__/**`).
 *
 * ## Why an allowlist instead of a rule
 *
 * A name the document uses and the tree does not have is one of two things, and
 * **they are indistinguishable from outside**: 陳腐化 (the code moved and the
 * document did not) or 未実装 (the document describes something still to build).
 * A design policy has to be allowed to name what it is asking for. Prose markers
 * do not separate them either — 「新設する」 sits in the same table as 「既存の」,
 * and #1939's move of `src/lib/__tests__/**` falsified a sentence that said 既存.
 *
 * So this guard never decides which one a dangling name is. A human decides,
 * once, by adding a row to {@link DECLARED} with a reason. What is then fully
 * mechanical is the pair of **transitions**, and those are what is pinned:
 *
 *  - **resolved → unresolved** — a rename or a deletion just landed and the
 *    document still points at the old name. The finding has no row, so the build
 *    goes red *at the commit that created the staleness* rather than an Epic
 *    later. Both #1900 and #1933 are exactly this shape.
 *  - **unresolved → resolved** — something the document plans has landed. The
 *    row stops producing a finding, and the failure says to fix the document's
 *    tense (usually a `- [ ]`) and delete the row.
 *
 * ## Why a unit test rather than a fifth `scripts/check-*.mjs`
 *
 * Same trade `tests/unit/guards/test-file-placement.test.ts` made, for the same
 * reason. The four static guards are separate scripts because each is a CI job
 * that has to be able to fail in seconds, ahead of the long unit suite
 * (`.commandmate/verify.yaml`, Issue #1882). This rule has no such requirement:
 * a design document changes a handful of times per Epic, and nothing downstream
 * is waiting on a sub-second verdict about it. `npm run test:unit` is already
 * declared in **both** `.commandmate/verify.yaml` and `.github/workflows/ci-pr.yml`,
 * so landing here puts the rule on both surfaces with no new declaration — and a
 * fifth script would mean two more declarations that can drift apart, which is
 * the defect #1882 removed from the static guards.
 *
 * ## Scope
 *
 * One document. The sweep is cheap to point at another (`auditDesignDoc` takes a
 * path), but every document costs its own reviewed allowlist, and this is the
 * one Epic #1921 treats as normative.
 *
 * What is **not** checked: counts. The document says 「実測 38 ファイル」 and
 * 「31 件」 in several places; this guard reads names, never quantities, and the
 * #1995 sweep re-measured exactly one table (§4 D3's tool-name comparisons).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditDesignDoc,
  classifySpan,
  expandBraces,
  extractSpans,
  loadCorpus,
  stripComments,
  type Corpus,
  type Finding,
} from '../../../scripts/design-doc-identifiers';

const DOC = 'docs/design/multi-agent-state-architecture.md';

/**
 * Why a dangling name is allowed to be dangling.
 *
 * - `planned`   — the document is asking for it. Not built yet, correctly named.
 * - `history`   — a name kept as the record of a retraction, rename or deletion.
 * - `external`  — vocabulary that belongs to something outside this repository.
 * - `prose`     — a name the document gave a mechanism whose code spelling differs.
 * - `test-only` — real, and correctly living only under `tests/`.
 */
type Category = 'planned' | 'history' | 'external' | 'prose' | 'test-only';

interface Declared {
  /** The backtick span exactly as the document writes it. */
  text: string;
  category: Category;
  why: string;
}

/**
 * The audited inventory, as of the #1995 sweep (2026-08-23, develop `2d33c839`).
 *
 * Sorted by `text`, which is the order `auditDesignDoc` reports in, so a diff
 * that adds a row lands next to the rows it belongs with.
 */
const DECLARED: readonly Declared[] = [
  {
    text: 'allowTypeImports',
    category: 'external',
    why: '`@typescript-eslint/no-restricted-imports` のオプション名。§4 D4 / DR3-001 が「採らない」と決めた選択肢なので、実装に現れないのが正しい',
  },
  {
    text: 'alternate_on',
    category: 'external',
    why: 'tmux の display option 名（`history_size` と対で引かれる）。付録 A の注記',
  },
  {
    text: 'capabilities_probe_unavailable',
    category: 'planned',
    why: '§7 が `GET /api/capabilities` の判定不能ケースに新設する理由コード',
  },
  {
    text: 'decision_evicted',
    category: 'planned',
    why: '§10.10 / DR1-021 が「`pendingDecisions` の破棄を無言で行わない」ために新設する理由コード',
  },
  {
    text: 'decision_timeout',
    category: 'history',
    why: 'DR2-004 が `dialog_timeout` へ改名した旧名。§7 と §4 D3 が改名の事実として引いている',
  },
  {
    text: 'dialog_timeout',
    category: 'planned',
    why: '§4 D3 決定 3 が新設する `releasedBy` の値。`agent-event-state.ts` のコメントが設計語として先に引いている（`releasedBy` 自体は未実装）',
  },
  {
    text: 'getCaptureWindow()',
    category: 'planned',
    why: '§4 D4 が `src/lib/session/` に新設すると決めた `session` ファサードの片方。Phase 2',
  },
  {
    text: 'getStatusCaptureLines',
    category: 'history',
    why: '#1933 が削除した private 関数。§4 D3 表 / §6.3 / §12 / §13 / §14.3 が「削除済み」であることの記録として名前を残している',
  },
  {
    text: 'ImportExpression',
    category: 'test-only',
    why: 'ガード自身の型（`tests/unit/guards/tmux-import-allowlist.test.ts`）。§4 D4 の lint ルール記述が参照しており、`tests/` の中に在るのが正しい',
  },
  {
    text: 'innerHTML',
    category: 'external',
    why: 'DOM API。§10.13（XSS）と §15.7 が「`dangerouslySetInnerHTML` / 直接代入を使わない」と書くために引いている',
  },
  {
    text: 'invalidateSessionCache()',
    category: 'planned',
    why: '§4 D4 が `src/lib/session/` に新設すると決めた `session` ファサードのもう片方。Phase 2',
  },
  {
    text: 'lastTurn',
    category: 'planned',
    why: '§4 D3 決定 2 の additive 追加候補。#1926 / #1930 は `turnId` / `openedAt` / `closedAt` / `closedBy` を `structuredEvents` に着地させたが、`lastTurn` は入っていない',
  },
  {
    text: 'MAX_EVENT_ID_LENGTH',
    category: 'planned',
    why: '§10.1 が「別名 `MAX_EVENT_ID_LENGTH` を置く場合も同じ定数を参照し、値を複製しない」と条件つきで書いた名前。§14 の 3 行はレビュー履歴が同じ名前を引いている',
  },
  {
    text: 'OPENCODE_SERVER_PASSWORD',
    category: 'external',
    why: 'opencode CLI 自身の環境変数。§15.1 の未決事項（ポート identity の強化）で、採用するかどうかがまだ決まっていない',
  },
  {
    text: 'readBoundedId',
    category: 'planned',
    why: '§6.2 / DR4-001 が `src/lib/hooks/sources/event-mapper.ts` に新設すると決めた共通バリデータ',
  },
  {
    text: 'tests/unit/hooks/sources/event-id-validation.test.ts',
    category: 'planned',
    why: '§11 が「新規」と明記したテスト。§13.2 S1〜S3 の受入条件の置き場',
  },
  {
    text: 'tests/unit/session/consumer-contract.test.ts',
    category: 'planned',
    why: '§11 が「新規、DR1-020」と明記した消費者契約テスト',
  },
  {
    text: 'turnStaleAfterMs',
    category: 'planned',
    why: '§4 D3 決定 2 が新設する turn の期限値（既定は `STRUCTURED_STATE_MAX_AGE_MS` と同値）。`status-evidence.ts` のコメントが設計語として先に引いている',
  },
  {
    text: 'unclassified_frames',
    category: 'prose',
    why: '本書が観測記録の種別に付けた呼び名。実体は `observeUnclassifiedFrame`（`src/lib/detection/unclassified-frame-tracker.ts`）で、この綴りの識別子はコードに無い',
  },
  {
    text: 'wait_until_busy',
    category: 'external',
    why: 'commandmate-skills 側 demo-video の probe 名。§6.1 / §9 / §13 が「この probe が evidence を問うていない」ことを言うために引いている',
  },
];

/** One shared read of the tree for every case below. */
const corpus: Corpus = loadCorpus();
const findings: Finding[] = auditDesignDoc(DOC, corpus);

const describeFinding = (f: Finding): string =>
  `  ${f.status.padEnd(12)} ${f.kind.padEnd(9)} \`${f.text}\`  (L${f.lines.slice(0, 5).join(', ')})` +
  (f.detail ? `  — seen only in ${f.detail}` : '');

describe('the design doc names only code that exists', () => {
  it('finds spans at all (guards against a broken extractor)', () => {
    /* If the extractor silently stopped matching, every assertion below would
       pass vacuously. The document is 1300+ lines of backtick-dense prose; a
       working run sees several hundred distinct spans. */
    const spans = extractSpans(readFileSync(join(process.cwd(), DOC), 'utf8'));
    expect(spans.size).toBeGreaterThan(500);
  });

  it('has no unresolved reference that nobody has declared', () => {
    const declared = new Set(DECLARED.map((d) => d.text));
    const undeclared = findings.filter((f) => !declared.has(f.text));

    expect(
      undeclared.map(describeFinding),
      `${DOC} names ${undeclared.length} thing(s) that are not in the tree and are not declared ` +
        `in DECLARED.\n\n` +
        `If the code moved or was deleted (陳腐化), FIX THE DOCUMENT — that is what this ` +
        `guard is for, and #1900 / #1933 are what it costs not to.\n` +
        `If the document is asking for something not built yet (未実装), or the name belongs ` +
        `to tmux / ESLint / opencode / the DOM / another repo, add a row to DECLARED with a ` +
        `reason.\n\n` +
        undeclared.map(describeFinding).join('\n')
    ).toEqual([]);
  });

  it('has no declared entry that has since landed', () => {
    const reported = new Set(findings.map((f) => f.text));
    const landed = DECLARED.filter((d) => !reported.has(d.text));

    expect(
      landed.map((d) => `  \`${d.text}\` (${d.category}) — ${d.why}`),
      `${landed.length} DECLARED entr(ies) now resolve to real code. That is good news and a ` +
        `stale document: whatever the doc says about them is written in the future tense, and ` +
        `§13's checklist probably still has a \`- [ ]\` for it.\n` +
        `Update the document, then delete the row(s):\n` +
        landed.map((d) => `  \`${d.text}\` (${d.category}) — ${d.why}`).join('\n')
    ).toEqual([]);
  });
});

describe('DECLARED is reviewable', () => {
  it('gives every entry a reason', () => {
    const empty = DECLARED.filter((d) => d.why.trim().length < 20);
    expect(empty.map((d) => d.text)).toEqual([]);
  });

  it('keeps the same order the report uses, so a new row lands where it belongs', () => {
    const texts = DECLARED.map((d) => d.text);
    expect(texts).toEqual([...texts].sort((a, b) => a.localeCompare(b)));
  });

  it('has no duplicate entry', () => {
    const seen = DECLARED.map((d) => d.text);
    expect(seen.length).toBe(new Set(seen).size);
  });

  it('records how the inventory splits, so a growing `planned` pile is visible', () => {
    const byCategory = DECLARED.reduce<Record<string, number>>((acc, d) => {
      acc[d.category] = (acc[d.category] ?? 0) + 1;
      return acc;
    }, {});

    /* The 2026-08-23 inventory. Not a cap — a receipt. A diff that moves these
       numbers is a diff that changed what the document promises, and it should
       be visible in review rather than absorbed silently. */
    expect(byCategory).toEqual({
      planned: 11,
      history: 2,
      external: 5,
      prose: 1,
      'test-only': 1,
    });
  });
});

/**
 * Mutation injection. Every assertion above is of the form "this list is empty",
 * and an extractor that matched nothing would satisfy all of them. These cases
 * feed the auditor a document that is wrong on purpose and require it to say so.
 */
describe('the auditor is not vacuous', () => {
  const withSyntheticDoc = <T>(markdown: string, run: (path: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-1995-'));
    const path = join(dir, 'synthetic.md');
    writeFileSync(path, markdown, 'utf8');
    try {
      return run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reports a name the tree does not have, and stays quiet about one it does', () => {
    const report = withSyntheticDoc(
      [
        '# synthetic',
        '',
        'The real one is `openOpencodeEventStream`, exported from',
        '`src/lib/hooks/sources/opencode/client.ts`.',
        '',
        'The name #1900 deleted is `readOpencodeEventStream`.',
      ].join('\n'),
      (path) => auditDesignDoc(path, corpus)
    );

    const reported = report.map((f) => f.text);
    expect(reported).toContain('readOpencodeEventStream');
    expect(reported).not.toContain('openOpencodeEventStream');
    expect(reported).not.toContain('src/lib/hooks/sources/opencode/client.ts');
  });

  it('separates "only in a comment" from "nowhere at all"', () => {
    /* This is the distinction that makes the report worth reading: a deletion
       usually leaves a comment behind saying it happened (#1900 and #1933 both
       did), while a name that never existed leaves nothing. */
    const report = withSyntheticDoc(
      ['# synthetic', '', '`readOpencodeEventStream` and `StatusVerdict`.'].join('\n'),
      (path) => auditDesignDoc(path, corpus)
    );

    const byText = new Map(report.map((f) => [f.text, f.status]));
    expect(byText.get('readOpencodeEventStream')).toBe('comment-only');
    expect(byText.get('StatusVerdict')).toBe('missing');
  });

  it('reports a path that resolves to nothing', () => {
    const report = withSyntheticDoc(
      [
        '# synthetic',
        '',
        'Moved by #1939: `src/lib/__tests__/status-detector.test.ts`.',
        'Where it lives now: `tests/unit/lib/status-detector-per-tool.test.ts`.',
        'Cited the short way: `auto-yes/route.ts`.',
        'Template: `tests/unit/detection/tools/<tool>/fixtures.test.ts`.',
        'Ellipsis, deliberately unreal: `.../i/route.ts`.',
      ].join('\n'),
      (path) => auditDesignDoc(path, corpus)
    );

    expect(report.map((f) => f.text)).toEqual(['src/lib/__tests__/status-detector.test.ts']);
  });

  it('does not resolve a name through its own source', () => {
    /* `scripts/design-doc-identifiers.ts` and this file both name
       `readOpencodeEventStream` in prose. A guard that reads its own text as
       evidence resolves precisely the names it exists to catch. */
    const named = corpus.code.scripts
      .concat(corpus.code.tests)
      .filter((f) => /design-doc-identifier/.test(f.file));
    expect(named).toEqual([]);
  });

  it('reads a name out of a fenced type position, not just inline prose', () => {
    const report = withSyntheticDoc(
      ['# synthetic', '', '```ts', 'export interface Sketch {', '  detect(): NoSuchVerdictType;', '}', '```'].join(
        '\n'
      ),
      (path) => auditDesignDoc(path, corpus)
    );
    expect(report.map((f) => f.text)).toContain('NoSuchVerdictType');
  });
});

describe('the auditor primitives', () => {
  it('strips comments without eating code', () => {
    const stripped = stripComments('const a = 1; // readOpencodeEventStream\n/* b */ const c = 2;');
    expect(stripped).not.toMatch(/readOpencodeEventStream/);
    expect(stripped).toMatch(/const a = 1;/);
    expect(stripped).toMatch(/const c = 2;/);
  });

  it('leaves a URL alone when stripping line comments', () => {
    expect(stripComments("const u = 'https://example.test/x';")).toMatch(/example\.test/);
  });

  it('expands nested brace groups', () => {
    expect(expandBraces('tests/unit/lib/{a,b}.test.ts')).toEqual([
      'tests/unit/lib/a.test.ts',
      'tests/unit/lib/b.test.ts',
    ]);
  });

  it('classifies the shapes the document actually writes', () => {
    expect(classifySpan('ScraperVerdict')).toEqual({ kind: 'type', key: 'ScraperVerdict' });
    expect(classifySpan('MAX_EVENT_ID_LENGTH')).toEqual({ kind: 'constant', key: 'MAX_EVENT_ID_LENGTH' });
    expect(classifySpan('captureSpec()')).toEqual({ kind: 'function', key: 'captureSpec' });
    expect(classifySpan('ICLITool.killSession')).toEqual({ kind: 'member', key: 'killSession' });
    expect(classifySpan('port_identity_changed')).toEqual({ kind: 'code', key: 'port_identity_changed' });
    expect(classifySpan('src/lib/tmux/tmux.ts')).toEqual({ kind: 'path', key: 'src/lib/tmux/tmux.ts' });
  });

  it('ignores prose, values and bare command words', () => {
    /* `ready` / `running` are `SessionStatus` values and `wait` is a command;
       treating them as symbols would bury the report in noise. */
    for (const noise of ['ready', 'running', 'wait', 'commandmate status', "'positive' | 'none'", '@/lib/tmux/**']) {
      expect(classifySpan(noise)).toBeNull();
    }
  });
});
