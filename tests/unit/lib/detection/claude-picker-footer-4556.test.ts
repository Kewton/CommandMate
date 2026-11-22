/** @vitest-environment node */

/**
 * Issue #4556: claude 2.1.329 以降の `/model`・`/effort` の選択画面が選択画面と判定されなかった。
 *
 * 2.1.329 でフッターの文言が変わった（keybindings からキーを引く形への作り直し）。
 *   /model : `Enter to set as default · s to use this session only · Esc to cancel`
 *         →  `s to use this session only · Enter to save · Esc to cancel`
 *   /effort: `←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`
 *         →  `←/→ to adjust · s to use this session only · Enter to save · Esc to cancel`
 * 旧い文言だけを見ていた 3 つのパターン（CLAUDE_SELECTION_LIST_FOOTER /
 * CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN / SET_AS_DEFAULT_FOOTER_PATTERN）が外れ、
 * /effort は `ready / input_prompt`、/model は `multiple_choice`（Auto-Yes が答えうる・
 * 番号ボタンが出て押すと既定が書き換わる）と読まれていた。
 *
 * 新しい枝は `s to use this session only` と `Enter to save` の **組** で当てる。
 * `Enter to save` 単独・`s to use this session only` 単独は当てない（I3）。
 *
 * fixture は実機採取（claude 2.1.330、私設 tmux・空の CLAUDE_CONFIG_DIR、2026-11-22、ANSI 付き）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDetectPromptOptions,
  CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN,
  CLAUDE_SELECTION_LIST_FOOTER,
} from '@/lib/detection/cli-patterns';
import { stripAnsi } from '@/lib/detection/ansi';
import { CLAUDE_SAVE_PICKER_FOOTER_PATTERN } from '@/lib/detection/tools/claude/patterns';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import {
  readSelectionListShape,
  SET_AS_DEFAULT_FOOTER_PATTERN,
  shouldOfferOptionNumbers,
} from '@/lib/detection/selection-shape';

const ROOT = process.cwd();
const capture = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DIR = 'tests/fixtures/claude-picker-footer-4556';
const EFFORT_330 = capture(`${DIR}/claude-2.1.330-effort.raw.txt`);
const MODEL_330 = capture(`${DIR}/claude-2.1.330-model.raw.txt`);
const EFFORT_286 = capture('tests/fixtures/claude-effort-picker-3052/claude-2.1.286-effort.raw.txt');
const MODEL_286 = capture('tests/fixtures/claude-effort-picker-3052/claude-2.1.286-model.raw.txt');

const MODEL_FOOTER_330 = 's to use this session only · Enter to save · Esc to cancel';
const EFFORT_FOOTER_330 = '←/→ to adjust · s to use this session only · Enter to save · Esc to cancel';

const FORMS = [
  ['ANSI 付き', (raw: string): string => raw],
  ['stripAnsi 後', stripAnsi],
] as const;

const SCREENS_330 = [
  ['/effort 2.1.330', EFFORT_330],
  ['/model 2.1.330', MODEL_330],
] as const;

describe('Issue #4556 I1: 2.1.330 の /effort・/model（実機）は選択画面', () => {
  beforeEach(() => resetDetectPromptCache());

  it('fixture のフッターは採取した文言そのもの', () => {
    expect(stripAnsi(EFFORT_330)).toContain(EFFORT_FOOTER_330);
    expect(stripAnsi(MODEL_330)).toContain(MODEL_FOOTER_330);
  });

  it('新しいフッターは CLAUDE_SELECTION_LIST_FOOTER に合う', () => {
    expect(CLAUDE_SELECTION_LIST_FOOTER.test(EFFORT_FOOTER_330)).toBe(true);
    expect(CLAUDE_SELECTION_LIST_FOOTER.test(MODEL_FOOTER_330)).toBe(true);
  });

  it('組のパターンは ANSI を落とした文字列向け: ANSI が残った生の行には当たらない（今の動き）', () => {
    // 生の行では SGR の終端 `m` が `s` の直前に付く（`\x1b[38;5;246ms to use …`）。
    // 呼び出し側はどれも先に ANSI を落とすので、画面としての判定は上の I1（ANSI 付きの形）で当たる。
    const rawRow = MODEL_330.split('\n').find(row => row.includes('s to use this session only'));
    expect(rawRow).toBeDefined();
    expect(rawRow).toMatch(/\x1b\[[0-9;]*ms to use this session only/);
    expect(CLAUDE_SAVE_PICKER_FOOTER_PATTERN.test(rawRow!)).toBe(false);
    expect(CLAUDE_SAVE_PICKER_FOOTER_PATTERN.test(stripAnsi(rawRow!))).toBe(true);
    // 英字に続く `s` は組の始まりと読まない
    expect(CLAUDE_SAVE_PICKER_FOOTER_PATTERN.test('focus to use this session only · Enter to save')).toBe(false);
  });

  it('/model の新しいフッターは CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN に合う', () => {
    expect(CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN.test(MODEL_FOOTER_330)).toBe(true);
  });

  for (const [name, screen] of SCREENS_330) {
    it.each(FORMS)(`${name} %s: waiting / claude_selection_list / hasActivePrompt=false`, (_f, toForm) => {
      expect(detectSessionStatus(toForm(screen), 'claude')).toMatchObject({
        status: 'waiting',
        reason: STATUS_REASON.CLAUDE_SELECTION_LIST,
        hasActivePrompt: false,
      });
    });

    it.each(FORMS)(`${name} %s: detectPrompt は isPrompt=false（Auto-Yes は答えない）`, (_f, toForm) => {
      const result = detectPrompt(toForm(screen), buildDetectPromptOptions('claude'));
      expect(result.isPrompt).toBe(false);
      expect(result.promptData).toBeUndefined();
    });

    it.each(FORMS)(`${name} %s: shape は offersSessionScope=true・commitsDefaultOnEnter=true`, (_f, toForm) => {
      const shape = readSelectionListShape(toForm(screen));
      expect(shape.offersSessionScope).toBe(true);
      expect(shape.commitsDefaultOnEnter).toBe(true);
      expect(shouldOfferOptionNumbers(shape)).toBe(false);
    });
  }

  it('/model の shape は 5 択（番号ボタンは出さない）', () => {
    expect(readSelectionListShape(MODEL_330).optionCount).toBe(5);
  });
});

describe('Issue #4556 I2: 2.1.286 の fixture は今までどおり', () => {
  beforeEach(() => resetDetectPromptCache());

  it.each([
    ['/effort 2.1.286', EFFORT_286],
    ['/model 2.1.286', MODEL_286],
  ])('%s: waiting / claude_selection_list / isPrompt=false', (_n, screen) => {
    expect(detectSessionStatus(screen, 'claude')).toMatchObject({
      status: 'waiting',
      reason: STATUS_REASON.CLAUDE_SELECTION_LIST,
      hasActivePrompt: false,
    });
    expect(detectPrompt(screen, buildDetectPromptOptions('claude')).isPrompt).toBe(false);
  });

  it('/model 2.1.286 の shape は従来の値', () => {
    expect(readSelectionListShape(MODEL_286)).toMatchObject({
      optionCount: 9,
      offersSessionScope: true,
      commitsDefaultOnEnter: true,
    });
  });

  it('旧いフッターは今までどおり各パターンに合う', () => {
    const oldModel = 'Enter to set as default · s to use this session only · Esc to cancel';
    expect(CLAUDE_SELECTION_LIST_FOOTER.test(oldModel)).toBe(true);
    expect(CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN.test(oldModel)).toBe(true);
    expect(SET_AS_DEFAULT_FOOTER_PATTERN.test(oldModel)).toBe(true);
    expect(
      CLAUDE_SELECTION_LIST_FOOTER.test('←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'),
    ).toBe(true);
  });
});

/**
 * 既存の本物の質問の画面のフッターを差し替えた **合成** の画面。
 * `Enter to save` を持つ本物の質問の fixture はリポジトリに無いため（`git grep 'Enter to save' tests`
 * は 4556 の fixture だけ）、AskUserQuestion と同じ形の質問を作ってフッターだけを差し替える。
 */
const syntheticQuestion = (footer: string): string =>
  [
    '⏺ I need one decision before continuing.',
    '',
    '─'.repeat(80),
    ' ☐ Storage',
    '',
    'Which storage backend should the cache use?',
    '',
    '❯ 1. SQLite',
    '     Persist to the local database',
    '  2. Memory',
    '     Lose the cache on restart',
    '  3. Type something.',
    '',
    `  ${footer}`,
  ].join('\n');

describe('Issue #4556 I3: 組でない文言は選択画面と読まない（陰性対照）', () => {
  beforeEach(() => resetDetectPromptCache());

  const LONE_FOOTERS = [
    'Enter to save · Esc to cancel',
    'Enter to save',
    's to use this session only · Esc to cancel',
    'Enter to select · Enter to save · Esc to cancel',
    'Esc to cancel · Tab to amend',
  ];

  it.each(LONE_FOOTERS)('パターンは "%s" に合わない', footer => {
    expect(CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN.test(footer)).toBe(false);
    expect(SET_AS_DEFAULT_FOOTER_PATTERN.test(footer)).toBe(false);
    if (!footer.startsWith('Enter to select')) {
      expect(CLAUDE_SELECTION_LIST_FOOTER.test(footer)).toBe(false);
    }
  });

  it.each([
    'Enter to save · Esc to cancel',
    's to use this session only · Esc to cancel',
  ])('合成の質問（フッター "%s"）は質問のまま: multiple_choice・hasActivePrompt=true', footer => {
    const screen = syntheticQuestion(footer);
    const prompt = detectPrompt(screen, buildDetectPromptOptions('claude'));
    expect(prompt.isPrompt).toBe(true);
    expect(prompt.promptData?.type).toBe('multiple_choice');
    const status = detectSessionStatus(screen, 'claude');
    expect(status.reason).not.toBe(STATUS_REASON.CLAUDE_SELECTION_LIST);
    expect(status.hasActivePrompt).toBe(true);
    expect(readSelectionListShape(screen).commitsDefaultOnEnter).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I3: Claude の画面の fixture すべてを新旧のパターンに通す（#3052 と同じ手順）
// ---------------------------------------------------------------------------

/** 直す前のパターン（#4556 以前の src の値をそのまま写したもの）。 */
const OLD = {
  selectionList:
    /Enter\s+to\s+(?:select\s+.*to\s+navigate|confirm\s+·\s+(?:Esc|s\s+for\s+this\s+session\s+only)|set\s+as\s+default)/,
  modelOverlay: /Enter\s+to\s+set\s+as\s+default\b/i,
  setAsDefault: /\bEnter\s+to\s+set\s+as\s+default\b/i,
};
const NEW = {
  selectionList: CLAUDE_SELECTION_LIST_FOOTER,
  modelOverlay: CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN,
  setAsDefault: SET_AS_DEFAULT_FOOTER_PATTERN,
};

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/**
 * 走査の対象は名前でなく置き場で拾う（リーダー r1 の P3-4）。`tests/fixtures` と、tests/unit・
 * tests/integration の下の `fixtures` ディレクトリにある画面のファイルを **ツールを問わず全部**。
 * `canary/model-overlay.raw.txt` のように名前に claude を含まない Claude の画面も入る。
 * SET_AS_DEFAULT_FOOTER_PATTERN はツールを問わず readSelectionListShape で使われるので、
 * claude 以外の画面も対象にするのが正しい。`.md`（説明）は画面ではないので外す。
 */
const FIXTURE_ROOTS: readonly string[] = [
  'tests/fixtures',
  ...['tests/unit', 'tests/integration'].flatMap(base =>
    walkDirs(path.join(ROOT, base))
      .filter(d => path.basename(d) === 'fixtures')
      .map(d => path.relative(ROOT, d)),
  ),
];

function walkDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'node_modules')
    .flatMap(e => [path.join(dir, e.name), ...walkDirs(path.join(dir, e.name))]);
}

const SCREEN_EXT = /\.(txt|ansi|raw|capture|ts|json|jsonl|ndjson|body)$/;
const SCREEN_FILES: readonly string[] = [
  ...new Set(
    FIXTURE_ROOTS.flatMap(root => {
      const abs = path.join(ROOT, root);
      return fs.existsSync(abs) ? walk(abs) : [];
    }),
  ),
]
  .filter(f => SCREEN_EXT.test(f))
  .sort();

/**
 * `.ts` の fixture は、ソースの行に加えて、組み立てた画面（文字列の export と、引数なしで
 * 文字列を返す関数の export）も通す。配列を `join('\n')` して作る画面はソースの行でも拾えるが、
 * 組み立て後の形でも確かめる。悪性パッケージの fixture（skills/）と guards の入力は画面ではないので
 * 評価しない（ソースの行は走査する）。
 */
const EVALUATED_TS = SCREEN_FILES.filter(
  f => f.endsWith('.ts') && !/[/\\](skills|guards)[/\\]/.test(path.relative(ROOT, f)),
);

async function builtScreens(file: string): Promise<Array<{ name: string; text: string }>> {
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const out: Array<{ name: string; text: string }> = [];
  const visit = (name: string, value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      out.push({ name, text: value });
    } else if (typeof value === 'function' && value.length === 0 && !/^[A-Z]/.test(name.split('#').pop() ?? '')) {
      try {
        visit(`${name}()`, (value as () => unknown)(), depth);
      } catch {
        // 引数が要る組み立て関数は飛ばす（ソースの行で走査済み）
      }
    } else if (value !== null && typeof value === 'object' && depth < 3) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(`${name}.${k}`, v, depth + 1);
    }
  };
  for (const [k, v] of Object.entries(mod)) visit(`${path.relative(ROOT, file)}#${k}`, v, 0);
  return out;
}

describe('Issue #4556 I3: 既存の fixture に新しく当たるものが無い（全走査）', () => {
  const screens: Array<{ name: string; text: string }> = [];

  beforeAll(async () => {
    for (const file of SCREEN_FILES) {
      screens.push({ name: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') });
    }
    for (const file of EVALUATED_TS) screens.push(...(await builtScreens(file)));
  });

  it('走査は fixture を見つけている（名前に claude を含まない画面と .ts の画面も）', () => {
    expect(SCREEN_FILES.length).toBeGreaterThanOrEqual(500);
    const names = screens.map(s => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        `${DIR}/claude-2.1.330-effort.raw.txt`,
        `${DIR}/claude-2.1.330-model.raw.txt`,
        'tests/fixtures/canary/model-overlay.raw.txt',
        'tests/fixtures/canary/model-overlay.ts',
        'tests/fixtures/claude-model-overlay.ts',
        'tests/fixtures/claude-model-overlay.ts#CLAUDE_MODEL_OVERLAY_V2_1_218',
      ]),
    );
    // 組み立て後の画面も実際に入っている
    expect(names.filter(n => n.includes('#')).length).toBeGreaterThanOrEqual(300);
  });

  it('新しいパターンだけが当たる行は 4556 の fixture にしか無い', () => {
    const newlyHit = new Set<string>();
    for (const { name, text } of screens) {
      const rows = stripAnsi(text).split('\n');
      for (const key of Object.keys(NEW) as Array<keyof typeof NEW>) {
        rows.forEach((row, i) => {
          if (NEW[key].test(row) && !OLD[key].test(row)) newlyHit.add(`${key} ${name}:${i + 1}`);
          // 直したパターンは旧い当たりを 1 つも落とさない（I2）
          if (OLD[key].test(row) && !NEW[key].test(row)) newlyHit.add(`LOST ${key} ${name}:${i + 1}`);
        });
      }
    }
    expect([...newlyHit].sort()).toEqual(
      [
        // /effort も同じ組を持つので overlay のガードにも当たる（番号の行が無いので結果は変わらない）
        `modelOverlay ${DIR}/claude-2.1.330-effort.raw.txt`,
        `modelOverlay ${DIR}/claude-2.1.330-model.raw.txt`,
        `selectionList ${DIR}/claude-2.1.330-effort.raw.txt`,
        `selectionList ${DIR}/claude-2.1.330-model.raw.txt`,
        `setAsDefault ${DIR}/claude-2.1.330-effort.raw.txt`,
        `setAsDefault ${DIR}/claude-2.1.330-model.raw.txt`,
      ].map(prefix => expect.stringContaining(prefix)),
    );
  });
});
