/**
 * The AskUserQuestion picker scenarios (Issue #2486).
 *
 * #2486 was a picker `respond` could not answer: two questions, the first with
 * a `preview` on each option. `wait --on-prompt agent` exited 10 for it and
 * `respond "1"` came back `prompt_no_longer_active` with the picker still open.
 * Measured with these same inputs (`tests/fixtures/claude-live-2486/README.md`),
 * the preview pane was what refused it and the tab row was what polluted the
 * published question, so the scenarios vary exactly those two:
 *
 * | id | input | isolates |
 * |---|---|---|
 * | `askuserquestion-tabs` | the Issue's 2 questions, previews removed | the tab row |
 * | `askuserquestion-preview` | the Issue's question 1 alone | the preview pane |
 * | `askuserquestion-tabs-preview` | the Issue's input verbatim | the Issue |
 * | `askuserquestion-respond-walk` | the Issue's input verbatim | `wait` → `respond "1"` on every screen, through Submit |
 *
 * Claude is handed the input as a file (`ask.json`, seeded by the runner)
 * rather than typed: the Issue's input is ~3 KB of Japanese, and reading it with
 * the Read tool also puts a previous tool's row above the picker — the role the
 * Bash call played on the Issue's pane, and one of the rows the question used to
 * swallow.
 */

import {
  expectAskUserQuestionAnswered,
  expectAskUserQuestionPicker,
  showsAnsweredTab,
  showsReviewScreen,
  showsText,
  type AskUserQuestionPickerShape,
} from './askuserquestion-expectations';
import { expectIdleReady, expectModelOverlay } from './expectations';
import { walkWithRespond } from './respond-walk';
import type { CanaryScenario, ScenarioDriver } from './types';

interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/**
 * The Issue's AskUserQuestion input, verbatim from the Claude transcript
 * (2026-09-11T11:42:30Z). Nothing in it identifies anyone; it names the sandbox
 * repository the Issue was found in.
 */
export const ISSUE_2486_QUESTIONS: readonly AskQuestion[] = [
  {
    question:
      'cmate-workspace-research の preflight（run の作成前・子への送信前）です。子 2 つはどちらも解決済み（claude-2 = Claude 2 / command-code = Command Code、どちらもこの worktree・running・Auto-Yes ON。自分 = claude は含まれていません）。調査中に子が read-only コマンド（git log / npm ls など）を使うときの権限をどう扱いますか？ 右のプレビューに子ごとの権限表があります。',
    header: '権限モード',
    multiSelect: false,
    options: [
      {
        label: '整えた状態で続行 (Recommended)',
        description:
          'prepared。子側の権限は整っている（または今あなたが整えた）ものとして、子に read-only コマンドの使用を許す。親は子の auto-yes や settings に触れません。',
        preview:
          '子の権限表（instances --json より）\n\n| 子           | cliTool      | running | autoYes | 整え方と現状                              | Web          |\n|--------------|--------------|---------|---------|-------------------------------------------|--------------|\n| claude-2     | claude       | true    | true    | .claude/settings.local.json allow         | probe で判定 |\n|              |              |         |         | 現状: settings.json に git log/show/      |              |\n|              |              |         |         | status/diff・node・cat・ls、               |              |\n|              |              |         |         | settings.local.json に npm ls/view/        |              |\n|              |              |         |         | outdated・grep・find・WebFetch・           |              |\n|              |              |         |         | WebSearch が既にある → 追加不要に見える    |              |\n| command-code | command-code | true    | true    | 未計測。Auto-Yes を人が ON（現状 ON）      | probe で判定 |\n\n注意: Auto-Yes ON でも prompt 検出が先に exit 10 を返すことがある\n(CommandMate#2463)。exit 10 が出た子はその子だけ止め、prompt を\nあなたに写します（親は respond しない）。',
      },
      {
        label: 'ファイル読取のみで続行',
        description:
          'files_only。子の role ファイルに「コマンドを実行しない。ファイルを読むだけ」と書く。git log / npm ls / node --version で得られる情報は Unknowns と Recommended Next Actions に回ります。',
        preview:
          'files_only のとき子に書く規則:\n\n  run no command at all; read files only.\n\n失うもの:\n- git log / git show による履歴の確認\n- npm ls による依存ツリーの確認\n- node --test を Node 24 で実際に回す確認\n  （いずれも Unknowns / Recommended Next Actions へ）',
      },
    ],
  },
  {
    question:
      'brief.md に書く Research Goal の 1 行案です:「このリポジトリ（harness-pack-uat-sandbox）の実行・テスト・CI の Node.js を 22 系から 24 系へ上げたとき、壊れるもの（blocker）・要修正箇所・未確認事項があるかを判断可能にする（移行手順の作成・実装は対象外）」。対象範囲はどうしますか？',
    header: 'Goal/範囲',
    multiSelect: false,
    options: [
      {
        label: 'この Goal・repo 全体 (Recommended)',
        description:
          'src/・tests/・package.json・CI に加え、repo に同梱された Skill の runner scripts（.claude/skills, .agents/skills の .mjs）も Node で動くコードとして対象に含める。',
      },
      {
        label: 'この Goal・アプリ部分のみ',
        description:
          'src/・tests/・package.json・package-lock.json・.github/workflows だけを対象にし、同梱 Skill の runner scripts は対象外にする。',
      },
    ],
  },
];

const [Q1, Q2] = ISSUE_2486_QUESTIONS;

/** The two options the picker appends to a question drawn WITHOUT a preview. */
const PICKER_META_OPTIONS = ['Type something.', 'Chat about this'];

/** The first line of question 1's highlighted preview. */
const Q1_PREVIEW_HEAD = '子の権限表（instances --json より）';

const ASK_FILE = 'ask.json';

/** What the session is asked to do. Short on purpose: the input is in the file. */
const ASK_PROMPT =
  `Read the file ${ASK_FILE} in the current directory with the Read tool. Then call the AskUserQuestion tool exactly once, ` +
  'passing the JSON object in that file verbatim as the tool input (same questions, headers, options, descriptions and previews). ' +
  'Do not do anything else and do not run any other tool.';

function withoutPreviews(question: AskQuestion): AskQuestion {
  return { ...question, options: question.options.map(({ label, description }) => ({ label, description })) };
}

function askFile(questions: readonly AskQuestion[]): Record<string, string> {
  return { [ASK_FILE]: `${JSON.stringify({ questions }, null, 2)}\n` };
}

const SHAPE_TABS: AskUserQuestionPickerShape = {
  id: 'tabs',
  headers: [Q1.header, Q2.header],
  tabBar: true,
  previewText: null,
  question: Q1.question,
  options: [...Q1.options.map(option => option.label), ...PICKER_META_OPTIONS],
};

const SHAPE_PREVIEW: AskUserQuestionPickerShape = {
  id: 'preview',
  headers: [Q1.header],
  tabBar: false,
  previewText: Q1_PREVIEW_HEAD,
  question: Q1.question,
  // Beside a preview the picker draws no `Type something.`, and its
  // `Chat about this` carries no number.
  options: Q1.options.map(option => option.label),
};

const SHAPE_TABS_PREVIEW: AskUserQuestionPickerShape = {
  ...SHAPE_PREVIEW,
  id: 'tabs-preview',
  headers: [Q1.header, Q2.header],
  tabBar: true,
};

const expectIssuePicker = expectAskUserQuestionPicker(SHAPE_TABS_PREVIEW);

const ANSWERS = [Q1.options[0].label, Q2.options[0].label];

async function askFromFile(driver: ScenarioDriver): Promise<void> {
  await driver.submitPrompt(ASK_PROMPT);
}

export const ASK_USER_QUESTION_SCENARIOS: readonly CanaryScenario[] = [
  {
    id: 'askuserquestion-tabs',
    tool: 'claude',
    title: 'AskUserQuestion: two questions, no preview (the tab row alone)',
    intent:
      'Issue #2486 with the previews removed. The tab row `←  ☐ 権限モード  ☐ Goal/範囲  ✔ Submit  →` never stopped the dialog rule, but it — and the previous tool\'s row above it — led the published `question` and `approvalTarget`. The question must be the question alone.',
    cost: 'small',
    timeoutMs: 180_000,
    pollIntervalMs: 2_000,
    workspaceFiles: askFile(ISSUE_2486_QUESTIONS.map(withoutPreviews)),
    expectation: expectAskUserQuestionPicker(SHAPE_TABS),
    // The picker stays up until answered, so an idle composer is unreachable.
    mutantExpectation: expectIdleReady,
    resetKeys: ['Escape'],
    drive: askFromFile,
  },
  {
    id: 'askuserquestion-preview',
    tool: 'claude',
    title: 'AskUserQuestion: one question whose options carry a preview',
    intent:
      'Issue #2486\'s question 1 alone. The preview pane opens to the right of the options and puts ~20 rows between them and the footer: the dialog rule found no options, `/prompt-response` refused the open picker as `prompt_no_longer_active`, and the pane\'s glyphs rode along in the option labels.',
    cost: 'small',
    timeoutMs: 180_000,
    pollIntervalMs: 2_000,
    workspaceFiles: askFile([Q1]),
    expectation: expectAskUserQuestionPicker(SHAPE_PREVIEW),
    mutantExpectation: expectIdleReady,
    resetKeys: ['Escape'],
    drive: askFromFile,
  },
  {
    id: 'askuserquestion-tabs-preview',
    tool: 'claude',
    title: 'AskUserQuestion: the Issue #2486 picker (two questions, previews on the first)',
    intent:
      'The Issue\'s input verbatim — the screen its `respond "1"` was refused on. Both the tab row and the preview pane are on screen; `wait` and `respond` must agree that it is an answerable dialog with the picker\'s own two options.',
    cost: 'small',
    timeoutMs: 180_000,
    pollIntervalMs: 2_000,
    workspaceFiles: askFile(ISSUE_2486_QUESTIONS),
    expectation: expectIssuePicker,
    mutantExpectation: expectIdleReady,
    resetKeys: ['Escape'],
    drive: askFromFile,
  },
  {
    id: 'askuserquestion-respond-walk',
    tool: 'claude',
    title: 'AskUserQuestion: `wait` → `respond "1"` through question 1, question 2 and Submit',
    intent:
      'The Issue\'s whole flow, answered the way an orchestrator answers it: on each screen `wait --on-prompt agent` must stop, and `respond "1"` — `/prompt-response`\'s own verification and `sendPromptAnswer` through production tmux code — must be accepted and move the picker on. Green means Claude\'s transcript records both answers, which no key-pressing shortcut could fake without every step being accepted.',
    cost: 'small',
    timeoutMs: 60_000,
    pollIntervalMs: 2_000,
    workspaceFiles: askFile(ISSUE_2486_QUESTIONS),
    expectation: expectAskUserQuestionAnswered(ANSWERS),
    // Unreachable after a submitted answer set: nothing opens the /model overlay.
    // (An idle composer is NOT a usable mutant here — the turn ends idle.)
    mutantExpectation: expectModelOverlay,
    resetKeys: ['Escape'],
    async drive(driver): Promise<void> {
      await askFromFile(driver);
      await driver.waitFor(expectIssuePicker.matches, {
        timeoutMs: 180_000,
        pollIntervalMs: 2_000,
        label: expectIssuePicker.label,
      });
      await walkWithRespond(driver, [
        {
          screen: 'question 1 (tab row + preview pane)',
          answer: '1',
          next: {
            label: 'question 2 on screen, question 1 marked answered',
            reached: o => showsAnsweredTab(o.frame, Q1.header) && showsText(o.frame, Q2.question),
          },
        },
        {
          screen: 'question 2',
          answer: '1',
          next: { label: 'the review screen', reached: o => showsReviewScreen(o.frame) },
        },
        {
          screen: 'review (Submit answers)',
          answer: '1',
          next: { label: 'answers submitted', reached: expectAskUserQuestionAnswered(ANSWERS).matches },
        },
      ]);
    },
  },
];
