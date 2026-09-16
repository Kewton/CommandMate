/**
 * Issue #2586: the guides must show the table `commandmate ls` actually prints.
 *
 * `ls` grew REASON in #1926 and AUTO_YES in #2575, and neither landed in the
 * guides: the shipped build explained the six columns in `ls --help` alone. The
 * cheap fix would be to grep the docs for the word `AUTO_YES`, which goes green
 * on a heading and says nothing about whether the example under it is a table
 * this CLI could ever emit — the previous examples were hand-aligned and their
 * column widths already did not match the formatter's.
 *
 * So the examples are RENDERED here, from `createLsCommand()` against a mocked
 * `/api/worktrees`, and the docs must contain that exact block. A seventh column
 * — or a width rule that changes — fails this suite rather than drifting for
 * another two Issues. The fixtures are the ones the guides describe in prose, so
 * the rendered block is also the proof that `waiting` + `off` is reachable.
 *
 * `--help` is NOT re-asserted here: `ls-auto-yes-2575.test.ts` owns it. What is
 * asserted is that the three surfaces a user reads without a terminal — the JA
 * guide, the EN guide and the CLI's embedded `agent-operations` doc — agree with
 * the terminal.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../helpers/mock-api';
import { AGENT_OPERATIONS_GUIDE } from '../../../src/cli/docs/agent-operations';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const JA_GUIDE = 'docs/user-guide/cli-operations-guide.md';
const EN_GUIDE = 'docs/en/user-guide/cli-operations-guide.md';
const JA_TUTORIAL = 'docs/user-guide/tutorial.md';
const EN_TUTORIAL = 'docs/en/user-guide/tutorial.md';

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

/**
 * Frozen "now". Every countdown below is written relative to it, so `42:10`
 * stays `42:10` instead of flickering to `42:09` on a slow run — the same
 * freeze `ls-auto-yes-2575.test.ts` uses, and the reason the rendered block can
 * be pasted into a document at all.
 */
const NOW = new Date('2026-09-16T12:00:00Z').getTime();
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
});

async function renderLs(worktrees: unknown[]): Promise<string> {
  mockFetchResponse({ worktrees, repositories: [] });
  const { createLsCommand } = await import('../../../src/cli/commands/ls');
  const cmd = createLsCommand();
  await cmd.parseAsync(['node', 'ls']);
  return mockConsoleLog.mock.calls[0][0] as string;
}

const WAITING_TOP = { isSessionRunning: true, isWaitingForResponse: true, isProcessing: false };
const RUNNING_TOP = { isSessionRunning: true, isWaitingForResponse: false, isProcessing: true };
const READY_TOP = { isSessionRunning: true, isWaitingForResponse: false, isProcessing: false };
const IDLE_TOP = { isSessionRunning: false, isWaitingForResponse: false, isProcessing: false };

const READY_ENTRY = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: false,
  sessionStatusReason: 'input_prompt',
  statusEvidence: 'positive',
};
const RUNNING_ENTRY = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: true,
  sessionStatusReason: 'thinking_indicator',
  statusEvidence: 'positive',
};
const WAITING_ENTRY = {
  isRunning: true,
  isWaitingForResponse: true,
  isProcessing: false,
  sessionStatusReason: 'prompt_detected',
  statusEvidence: 'positive',
};
/** `statusEvidence: 'none'` — the frame was interactive and unreadable (#1926). */
const NO_EVIDENCE_ENTRY = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: false,
  sessionStatusReason: 'no_recent_output',
  statusEvidence: 'none',
};
/**
 * A tool with two instances: the server's per-tool aggregate drops the reason,
 * so REASON reads `-` while AUTO_YES still names the instance (#2575's note
 * that the two cells on one row can be about different sessions).
 */
const WAITING_ENTRY_AGGREGATED = {
  isRunning: true,
  isWaitingForResponse: true,
  isProcessing: false,
};

function armed(ms: number): { enabled: boolean; expiresAt: number } {
  return { enabled: true, expiresAt: NOW + ms };
}

/**
 * The rows the guides' example is about, in the guides' order. Between them
 * they reach every AUTO_YES value a current server can produce except `-`,
 * which needs a server older than #2512 and so cannot share a table with these.
 */
const GUIDE_ROWS = [
  {
    id: 'localllm-test',
    name: 'main',
    cliToolId: 'claude',
    ...READY_TOP,
    sessionStatusByCli: { claude: READY_ENTRY },
    sessionStatusByInstance: { claude: READY_ENTRY },
    autoYesByInstance: { claude: armed(42 * MINUTE + 10 * SECOND) },
  },
  {
    id: 'commandmate',
    name: 'develop',
    cliToolId: 'claude',
    ...RUNNING_TOP,
    sessionStatusByCli: { claude: RUNNING_ENTRY },
    sessionStatusByInstance: { claude: RUNNING_ENTRY },
    autoYesByInstance: { claude: armed(HOUR + 5 * MINUTE + 33 * SECOND) },
  },
  {
    id: 'commandmate-issue-518',
    name: 'feature/518-worktree',
    cliToolId: 'claude',
    ...READY_TOP,
    sessionStatusByCli: { claude: NO_EVIDENCE_ENTRY },
    sessionStatusByInstance: { claude: NO_EVIDENCE_ENTRY },
    autoYesByInstance: {},
  },
  {
    id: 'commandmate-issue-600',
    name: 'feature/600-sessions',
    cliToolId: 'claude',
    ...WAITING_TOP,
    sessionStatusByCli: { claude: WAITING_ENTRY },
    sessionStatusByInstance: { claude: WAITING_ENTRY },
    autoYesByInstance: {},
  },
  {
    id: 'commandmate-issue-644',
    name: 'feature/644-repos',
    cliToolId: 'claude',
    ...WAITING_TOP,
    sessionStatusByCli: { codex: WAITING_ENTRY_AGGREGATED },
    sessionStatusByInstance: { 'codex-2': WAITING_ENTRY },
    autoYesByInstance: { 'codex-2': armed(3 * MINUTE + 12 * SECOND) },
  },
  {
    id: 'commandmate-main',
    name: 'main',
    cliToolId: 'claude',
    ...IDLE_TOP,
    autoYesByInstance: {},
  },
];

/** The tutorial's Step 1: one worktree, nothing started, nothing armed. */
const TUTORIAL_ROWS = [
  {
    id: 'commandmate-tutorial',
    name: 'main',
    cliToolId: 'claude',
    ...IDLE_TOP,
    autoYesByInstance: {},
  },
];

describe('[#2586] the ls table in the guides is the table ls prints', () => {
  it('the JA and EN operations guides carry the rendered six-column example', async () => {
    const rendered = await renderLs(GUIDE_ROWS);

    // Guard against a vacuous pass: a renderer that returned the headers alone
    // would be `includes`-matched by any document that happens to quote them.
    expect(rendered.split('\n')).toHaveLength(GUIDE_ROWS.length + 2);
    expect(rendered).toContain('AUTO_YES');

    expect(read(JA_GUIDE)).toContain(rendered);
    expect(read(EN_GUIDE)).toContain(rendered);
  });

  it('the JA and EN tutorials carry the rendered six-column example', async () => {
    const rendered = await renderLs(TUTORIAL_ROWS);

    expect(rendered.split('\n')).toHaveLength(TUTORIAL_ROWS.length + 2);

    expect(read(JA_TUTORIAL)).toContain(rendered);
    expect(read(EN_TUTORIAL)).toContain(rendered);
  });

  it('the example reaches every AUTO_YES value a current server can produce', async () => {
    // The point of the example, asserted on the example rather than on prose:
    // a `waiting` row reading `off` is the state #2575 exists to make visible,
    // and a reader has to be able to find one in the block they are shown.
    const cells = (await renderLs(GUIDE_ROWS))
      .split('\n')
      .slice(2)
      .map((line) => line.split(/\s{2,}/));

    const autoYes = cells.map((row) => row[row.length - 1]);
    expect(autoYes).toContain('42:10');
    expect(autoYes).toContain('1:05:33');
    expect(autoYes).toContain('off');
    expect(autoYes).toContain('03:12 (codex-2)');

    const waitingRows = cells.filter((row) => row[2] === 'waiting');
    expect(waitingRows.some((row) => row[row.length - 1] === 'off')).toBe(true);
  });
});

describe('[#2586] the column list is the same on every surface', () => {
  const COLUMNS = ['ID', 'NAME', 'STATUS', 'REASON', 'DEFAULT', 'AUTO_YES'];

  it('the CLI-embedded agent operations doc names all six columns in order', () => {
    // This string is what `commandmate docs agent-operations` prints, and it is
    // the copy an agent reads when the repo's docs/ are not installed.
    expect(AGENT_OPERATIONS_GUIDE).toContain(`Table format (${COLUMNS.join(', ')})`);
  });

  it('the embedded doc explains the AUTO_YES values it now advertises', () => {
    for (const value of ['off', 'on']) {
      expect(AGENT_OPERATIONS_GUIDE).toMatch(
        new RegExp(`^\\s+${value}\\s+-\\s`, 'm'),
      );
    }
    // `waiting` + `off` is the pair an orchestrator has to be able to act on.
    expect(AGENT_OPERATIONS_GUIDE).toContain('AUTO_YES values');
  });

  it('both guides give the AUTO_YES column a section of its own', () => {
    // `ja-en-heading-parity.test.ts` counts `##` only, which is why the EN guide
    // could lose #1926's REASON section without anything going red. These are
    // `###`, so they need their own assertion.
    expect(read(JA_GUIDE)).toMatch(/^### .*AUTO_YES/m);
    expect(read(EN_GUIDE)).toMatch(/^### .*AUTO_YES/m);
    expect(read(JA_GUIDE)).toMatch(/^### .*REASON/m);
    expect(read(EN_GUIDE)).toMatch(/^### .*REASON/m);
  });

  it('both guides document every AUTO_YES value', () => {
    for (const guide of [read(JA_GUIDE), read(EN_GUIDE)]) {
      const section = guide.slice(guide.search(/^### .*AUTO_YES/m));
      for (const value of ['`off`', '`on`', '`-`', '`42:10`', '`1:05:33`']) {
        expect(section).toContain(value);
      }
      // The Issue this column came from, so a reader can find the design.
      expect(section).toContain('#2575');
    }
  });
});
