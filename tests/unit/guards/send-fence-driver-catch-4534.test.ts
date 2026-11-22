/**
 * Issue #4534 r3, INV-catch: the fence's refusal (`isFenceRefusal`) is never
 * swallowed, never wrapped by a driver's catch — it is thrown on with its type
 * (and so its cause chain) intact.
 *
 * Two halves, both read off the drivers' source (no list of sites by hand):
 *
 * - T3c (run time): every `try … catch` of a driver whose `try` reaches a gate
 *   (a fence gate, or a function that reaches one — found by name over
 *   `src/lib`, a fixed point) is one row. Each row runs its driver through the
 *   path that enters that `try`, with the fence's refusal injected there: the
 *   call must not return, what comes out must be the fence's own refusal, and
 *   nothing more may be changed after it. Real from the driver down; fake:
 *   the process boundary (`./send-fence-process`), recorded screens, and
 *   OpenCode's port / subscription registry. agy is only ever the recorded
 *   screen and the fake process — no real agy, no `~/.gemini` (HOME is a
 *   private directory).
 * - Static: the same rows must start their `catch` with the rethrow
 *   (`rethrowFenceRefusal(e)` or `if (… isFenceRefusal(e) …) throw e`), or be a
 *   `catch` that always ends `throw e`. Positive control: the codex launch wait
 *   without its rethrow; negative control: today's tree.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * A private HOME and a private PATH, before any module reads them: the PATH
 * holds empty executable files only so the drivers' PATH walks find a binary to
 * probe — the probe itself goes to the fake process, so nothing is ever run.
 */
const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fence4534-catch-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex', 'copilot', 'gemini', 'agy', 'opencode', 'opencode2', 'command-code', 'cmd', 'vibe-local', 'vibe']) {
    fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
  }
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  return { root, saved };
});

vi.mock('child_process', async () => (await import('./send-fence-process')).fakeChildProcess());
vi.mock('@/lib/cli-tools/opencode-config', () => ({ ensureOpencodeConfig: vi.fn() }));
vi.mock('@/lib/hooks/sources/opencode/ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/ports')>()),
  getAssignedOpencodePort: vi.fn(() => null),
}));
vi.mock('@/lib/hooks/sources/opencode/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/subscription')>()),
  getOpencodeLiveness: vi.fn(() => ({ state: 'absent' })),
  getOpencodePrimarySession: vi.fn(() => null),
}));
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal),
);

import { addPane, resetWorld, world, type Out } from './send-fence-process';
import { REPO_ROOT } from './route-tmux-reach';
import {
  isFenceRefusal,
  resetFenceForTests,
  runWithSendTicket,
  SendTargetChangedError,
  type FenceRefusalReason,
} from '@/lib/session/terminal-fence';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { clearCachedClaudePath } from '@/lib/session/claude-session';
import { clearStartupTrust, markStartupTrustPending } from '@/lib/cli-tools/antigravity-startup-trust';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';
import { buildCopilotFolderTrustFrame, buildCopilotReadyFrame } from '@tests/fixtures/copilot-folder-trust-1080';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';
import { CODEX_HOOKS_REVIEW_PANE, CODEX_TRUST_DIALOG_PANE } from '@tests/fixtures/codex-hooks-review-0148';

registerIsolatedAgentHooksDir('fence4534-catch');

// ---------------------------------------------------------------------------
// The rows: every driver catch whose try reaches a gate
// ---------------------------------------------------------------------------

/** The drivers' files (and the claude driver's own session module). */
export const DRIVER_FILES = [
  'src/lib/cli-tools/base.ts',
  'src/lib/cli-tools/claude.ts',
  'src/lib/session/claude-session.ts',
  'src/lib/cli-tools/codex.ts',
  'src/lib/cli-tools/copilot.ts',
  'src/lib/cli-tools/gemini.ts',
  'src/lib/cli-tools/antigravity.ts',
  'src/lib/cli-tools/opencode.ts',
  'src/lib/cli-tools/opencode-v2.ts',
  'src/lib/cli-tools/command-code.ts',
  'src/lib/cli-tools/vibe-local.ts',
] as const;

/** What makes a call a change behind a gate: the gates themselves and the boundary notes. */
const GATE_SEEDS = [
  'fenceGate', 'fenceBatchOpen', 'fenceBatchStep', 'fenceConfirm', 'fenceConfirmDispatch', 'enterSendLayer', 'noteInputStart', 'noteDispatchStart',
];

const read = (f: string): string => readFileSync(join(REPO_ROOT, f), 'utf-8');

function sourceOf(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function calledNames(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) out.push(e.text);
      else if (ts.isPropertyAccessExpression(e)) out.push(e.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function libFiles(dir = join(REPO_ROOT, 'src', 'lib'), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) libFiles(path, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Every function name in `src/lib` that reaches a gate (by name: wider than the truth). */
function gatedNames(files: ReadonlyMap<string, string>): Set<string> {
  const bodies = new Map<string, ts.Node[]>();
  for (const [file, text] of files) {
    if (file.endsWith('terminal-fence.ts')) continue;
    const source = sourceOf(file, text);
    const visit = (n: ts.Node): void => {
      if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && n.body) {
        const name = n.name.getText(source);
        bodies.set(name, [...(bodies.get(name) ?? []), n.body]);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  const gated = new Set(GATE_SEEDS);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, list] of bodies) {
      if (!gated.has(name) && list.some((body) => calledNames(body).some((c) => gated.has(c)))) {
        gated.add(name);
        grew = true;
      }
    }
  }
  return gated;
}

export interface CatchRow {
  file: string;
  /** The enclosing method / function. */
  method: string;
  /** 1-based index among this method's rows (stable across line moves). */
  nth: number;
  line: number;
  /** The gated calls its `try` makes. */
  gated: string[];
  /** Whether the `catch` throws the fence's refusal on (see the file comment). */
  rethrows: boolean;
}

function enclosingMethod(node: ts.Node, source: ts.SourceFile): string {
  for (let c: ts.Node | undefined = node.parent; c; c = c.parent) {
    if ((ts.isMethodDeclaration(c) || ts.isFunctionDeclaration(c)) && c.name) return c.name.getText(source);
  }
  return '<module>';
}

function catchRethrows(clause: ts.CatchClause, source: ts.SourceFile): boolean {
  const binding = clause.variableDeclaration && ts.isIdentifier(clause.variableDeclaration.name) ? clause.variableDeclaration.name.text : null;
  if (binding === null) return false;
  const statements = clause.block.statements;
  const first = statements[0];
  if (first !== undefined) {
    // rethrowFenceRefusal(e);
    if (ts.isExpressionStatement(first) && ts.isCallExpression(first.expression) && ts.isIdentifier(first.expression.expression)
      && first.expression.expression.text === 'rethrowFenceRefusal' && first.expression.arguments[0]?.getText(source) === binding) return true;
    // if (… isFenceRefusal(e) …) throw e;
    if (ts.isIfStatement(first) && new RegExp(`\\bisFenceRefusal\\(${binding}\\)`).test(first.expression.getText(source))) {
      const then = ts.isBlock(first.thenStatement) ? first.thenStatement.statements[0] : first.thenStatement;
      if (then !== undefined && ts.isThrowStatement(then) && then.expression?.getText(source) === binding) return true;
    }
  }
  // A catch that always throws its own error on: no way out but `throw e` at the end.
  const last = statements[statements.length - 1];
  if (last === undefined || !ts.isThrowStatement(last) || last.expression?.getText(source) !== binding) return false;
  let escapes = false;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (n !== last && (ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isContinueStatement(n) || ts.isBreakStatement(n))) escapes = true;
    ts.forEachChild(n, visit);
  };
  visit(clause.block);
  return !escapes;
}

export function driverCatchRows(files: ReadonlyMap<string, string>, gated: ReadonlySet<string>): CatchRow[] {
  const rows: CatchRow[] = [];
  for (const file of DRIVER_FILES) {
    const text = files.get(file) ?? '';
    const source = sourceOf(file, text);
    const counts = new Map<string, number>();
    const visit = (n: ts.Node): void => {
      if (ts.isTryStatement(n) && n.catchClause) {
        const calls = [...new Set(calledNames(n.tryBlock).filter((c) => gated.has(c)))];
        if (calls.length > 0) {
          const method = enclosingMethod(n, source);
          const nth = (counts.get(method) ?? 0) + 1;
          counts.set(method, nth);
          rows.push({
            file,
            method,
            nth,
            line: source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1,
            gated: calls,
            rethrows: catchRethrows(n.catchClause, source),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  return rows;
}

const LIB = new Map(libFiles().map((path) => [path.slice(REPO_ROOT.length + 1), readFileSync(path, 'utf-8')] as const));
const GATED = gatedNames(LIB);
const ROWS = driverCatchRows(LIB, GATED);
const rowName = (r: CatchRow): string => `${r.file.replace(/^src\/lib\//, '')}#${r.method}${r.nth > 1 ? ` (${r.nth})` : ''}`;

// ---------------------------------------------------------------------------
// The world for T3c
// ---------------------------------------------------------------------------

const WT = 'wt-fence-catch';
const fixture = (...p: string[]): string => readFileSync(resolve(__dirname, '../../fixtures', ...p), 'utf8');
const SEP = '─'.repeat(40);
const CLAUDE_READY = ['⏺ ready', SEP, '\u001b[39m❯ ', SEP, '  ⏵⏵ auto mode on'].join('\n');

/** The idle screen each tool's readiness reads as ready. */
const READY: Partial<Record<CLIToolType, () => string>> = {
  claude: () => CLAUDE_READY,
  codex: () => ['• a reply', '', '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m', '', '  gpt-5.6-sol xhigh · /repo'].join('\n'),
  copilot: () => buildCopilotReadyFrame(),
  gemini: () => '> Type your message or @path/to/file',
  antigravity: () => fixture('antigravity-live-2364', 'boot-idle.txt'),
  opencode: () => buildOpencodeComposerFrame(),
  'opencode-v2': () => fixture('opencode-v2-live-2934', 'boot-idle.txt'),
  'command-code': () => fixture('command-code-live-2250', 'boot-idle.txt'),
  'vibe-local': () => fixture('vibe-local-readiness-4040', 'boot-ready.txt'),
};

/** The startup screen each tool's wait answers with a key (a trust / review screen). */
const STARTUP_SCREEN: Partial<Record<CLIToolType, () => string>> = {
  claude: () => fixture('launch-dialog-live-3790', 'claude-trust-2-1-302.txt'),
  codex: () => CODEX_TRUST_DIALOG_PANE,
  copilot: () => buildCopilotFolderTrustFrame(),
  gemini: () => fixture('gemini-live-3776', 'trust-dialog.txt'),
  antigravity: () => fixture('antigravity-live-2364', 'trust-dialog.txt'),
};

/** A screen the send's own prompt wait answers (codex: its hooks review; the others: the trust screen). */
const SEND_SCREEN: Partial<Record<CLIToolType, () => string>> = {
  codex: () => CODEX_HOOKS_REVIEW_PANE,
  copilot: () => buildCopilotFolderTrustFrame(),
  antigravity: () => fixture('antigravity-live-2364', 'trust-dialog.txt'),
};

let refusing = false;
const sessionOf = (tool: CLIToolType): string => resolveSessionName(tool, WT);

/** Run `fn` under a ticket for `tool` that refuses from the moment `refusing` is set. */
function underTicket<T>(tool: CLIToolType, fn: () => Promise<T>): Promise<T | Error> {
  return runWithSendTicket(
    {
      target: { worktreeId: WT, instanceId: tool, cliToolId: tool },
      resolvedBy: 'primary',
      kind: 'resolved',
      confirm: (): FenceRefusalReason | null => (refusing ? 'tool-changed' : null),
      names: [sessionOf(tool)],
    },
    fn,
  ).then(
    (v) => v,
    (e: unknown) => e as Error,
  );
}

/** Changes recorded after the refusal was armed. */
let armedAt = 0;
const changesAfterRefusal = (): string[] =>
  world.out.slice(armedAt).filter((o) => o.cls === 'change').map((o) => o.line.slice(0, 100));
const arm = (): void => {
  refusing = true;
  armedAt = world.out.length;
};

const tool = (id: CLIToolType) => CLIToolManager.getInstance().getTool(id);

/** A pane running `id` that shows `frame`. */
function runningPane(id: CLIToolType, frame: () => string): string {
  const session = sessionOf(id);
  addPane(session, id as never);
  world.display = (s, format) =>
    format.replace(/#\{(\w+)\}/g, (_m, key: string) => {
      if (key === 'session_path' || key === 'pane_current_path') return world.path;
      if (key === 'pane_current_command') return s === session ? 'node' : 'zsh';
      if (key === 'pane_pid') return '4242';
      if (key === 'window_width') return '200';
      if (key === 'window_height') return '1000';
      return '';
    });
  world.frame = (s) => (s === session ? frame() : null);
  return session;
}

type Scenario = (id: CLIToolType) => Promise<unknown>;

/** The launch, refused at its first gate (inside the launch's try). */
const launchRefused: Scenario = async (id) => {
  arm();
  return underTicket(id, () => tool(id).startSession(WT, world.path));
};

/** The launch, refused at the startup screen's key (inside the wait's try). */
const startupScreenRefused: Scenario = async (id) => {
  const session = sessionOf(id);
  const screen = STARTUP_SCREEN[id];
  if (screen === undefined) throw new Error(`no startup screen recorded for ${id}`);
  let launched = false;
  world.frame = (s) => (s === session && launched ? screen() : null);
  world.onCall = (o: Out) => {
    if (!launched && o.cls === 'change' && o.line.startsWith('send-keys') && o.session === session && / C-m$/.test(o.line) && !/unset CLAUDECODE/.test(o.line)) {
      launched = true;
      arm();
    }
  };
  return underTicket(id, () => tool(id).startSession(WT, world.path));
};

/** The send to a running pane, refused at its first gate. */
const sendRefused: Scenario = async (id) => {
  const ready = READY[id];
  if (ready === undefined) throw new Error(`no ready screen recorded for ${id}`);
  runningPane(id, ready);
  arm();
  return underTicket(id, () => tool(id).sendMessage(WT, 'refused body'));
};

/** The send's own prompt wait answering a screen, refused at that key. */
const sendScreenRefused: Scenario = async (id) => {
  const screen = SEND_SCREEN[id];
  if (screen === undefined) throw new Error(`no send-time screen recorded for ${id}`);
  const session = runningPane(id, screen);
  // agy's send-time wait answers its trust screen only while the startup trust is owed.
  if (id === 'antigravity') markStartupTrustPending(session);
  arm();
  return underTicket(id, () => tool(id).sendMessage(WT, 'refused body'));
};

/** copilot's `/model`, refused at its first key. */
const modelRefused: Scenario = async (id) => {
  runningPane(id, READY[id] as () => string);
  arm();
  return underTicket(id, () => (tool(id) as unknown as { sendModelCommand(w: string, m: string): Promise<void> }).sendModelCommand(WT, 'gpt-5.6-terra'));
};

/** The stop sequence, refused at its first key / kill (no retraction around it). */
const stopRefused: Scenario = async (id) => {
  runningPane(id, READY[id] as () => string);
  arm();
  return underTicket(id, () => tool(id).killSession(WT));
};

/** `file#method` → the tool and the path that enters that try. */
const SCENARIOS: Readonly<Record<string, { tool: CLIToolType; run: Scenario }>> = {
  'src/lib/cli-tools/base.ts#startSessionOnce': { tool: 'codex', run: launchRefused },
  'src/lib/cli-tools/base.ts#requestExitAndKill': { tool: 'codex', run: stopRefused },
  'src/lib/session/claude-session.ts#startClaudeSession': { tool: 'claude', run: launchRefused },
  'src/lib/session/claude-session.ts#answerTrustDialog': { tool: 'claude', run: startupScreenRefused },
  'src/lib/cli-tools/codex.ts#launchSession': { tool: 'codex', run: launchRefused },
  'src/lib/cli-tools/codex.ts#waitForReady': { tool: 'codex', run: startupScreenRefused },
  'src/lib/cli-tools/codex.ts#waitForPrompt': { tool: 'codex', run: sendScreenRefused },
  'src/lib/cli-tools/codex.ts#sendMessage': { tool: 'codex', run: sendRefused },
  'src/lib/cli-tools/copilot.ts#typeLeavingMarkOnFailure': { tool: 'copilot', run: sendRefused },
  'src/lib/cli-tools/copilot.ts#launchSession': { tool: 'copilot', run: launchRefused },
  'src/lib/cli-tools/copilot.ts#waitForReady': { tool: 'copilot', run: startupScreenRefused },
  'src/lib/cli-tools/copilot.ts#waitForPrompt': { tool: 'copilot', run: sendScreenRefused },
  'src/lib/cli-tools/copilot.ts#sendMessage': { tool: 'copilot', run: sendRefused },
  'src/lib/cli-tools/copilot.ts#sendModelCommand': { tool: 'copilot', run: modelRefused },
  'src/lib/cli-tools/gemini.ts#launchSession': { tool: 'gemini', run: launchRefused },
  'src/lib/cli-tools/gemini.ts#waitForReady': { tool: 'gemini', run: startupScreenRefused },
  'src/lib/cli-tools/gemini.ts#sendMessage': { tool: 'gemini', run: sendRefused },
  'src/lib/cli-tools/antigravity.ts#launchSession': { tool: 'antigravity', run: launchRefused },
  'src/lib/cli-tools/antigravity.ts#waitForReady': { tool: 'antigravity', run: startupScreenRefused },
  'src/lib/cli-tools/antigravity.ts#waitForPrompt': { tool: 'antigravity', run: sendScreenRefused },
  'src/lib/cli-tools/antigravity.ts#sendMessage': { tool: 'antigravity', run: sendRefused },
  'src/lib/cli-tools/opencode.ts#launchSession': { tool: 'opencode', run: launchRefused },
  'src/lib/cli-tools/opencode.ts#dispatchViaServer': { tool: 'opencode', run: sendRefused },
  'src/lib/cli-tools/opencode.ts#sendMessageAfterDispatch': { tool: 'opencode', run: sendRefused },
  'src/lib/cli-tools/opencode.ts#killSession': { tool: 'opencode', run: stopRefused },
  'src/lib/cli-tools/opencode-v2.ts#launchSession': { tool: 'opencode-v2', run: launchRefused },
  'src/lib/cli-tools/opencode-v2.ts#sendMessage': { tool: 'opencode-v2', run: sendRefused },
  'src/lib/cli-tools/opencode-v2.ts#killSession': { tool: 'opencode-v2', run: stopRefused },
  'src/lib/cli-tools/command-code.ts#launchSession': { tool: 'command-code', run: launchRefused },
  'src/lib/cli-tools/command-code.ts#sendMessage': { tool: 'command-code', run: sendRefused },
  'src/lib/cli-tools/vibe-local.ts#launchSession': { tool: 'vibe-local', run: launchRefused },
  'src/lib/cli-tools/vibe-local.ts#sendMessage': { tool: 'vibe-local', run: sendRefused },
};

let wtPath = '';
beforeAll(() => {
  wtPath = mkdtempSync(join(tmpdir(), 'fence4534-catch-wt-'));
});
afterAll(() => {
  process.env.HOME = sandbox.saved.HOME;
  process.env.PATH = sandbox.saved.PATH;
  rmSync(sandbox.root, { recursive: true, force: true });
  rmSync(wtPath, { recursive: true, force: true });
});

/** `--version` answers the drivers' executable probes read (to the fake process). */
function versionAnswer(line: string): string | null {
  if (!/\s--version$/.test(line)) return null;
  const bin = line.split(' ')[0].split('/').pop() ?? '';
  if (bin === 'copilot') return 'GitHub Copilot CLI 1.0.91.';
  if (bin === 'opencode') return '1.18.33';
  if (bin === 'opencode2') return '2.1.0';
  return '1.0.0';
}
beforeEach(() => {
  resetWorld();
  world.path = wtPath;
  const execAnswer = world.execAnswer;
  world.execAnswer = (line) => versionAnswer(line) ?? execAnswer(line);
  clearStartupTrust();
  resetFenceForTests();
  resetInstanceInputLocks();
  clearCachedClaudePath();
  refusing = false;
  armedAt = 0;
});
afterEach(() => {
  refusing = false;
});

describe('T3c (INV-catch, run time): every driver catch around a gate throws the refusal on, typed', () => {
  it('the table is the scan: every scanned row has its path, and every path still names a row', () => {
    const keys = new Set(ROWS.map((r) => `${r.file}#${r.method}`));
    expect([...keys].filter((k) => !(k in SCENARIOS))).toEqual([]);
    expect(Object.keys(SCENARIOS).filter((k) => !keys.has(k))).toEqual([]);
    expect(ROWS.length).toBeGreaterThan(20);
  });

  it.each(ROWS.map((r) => [rowName(r), r] as const))('[T3c] %s: refused inside its try → not returned, the refusal itself, nothing changed after it', async (_name, row) => {
    const scenario = SCENARIOS[`${row.file}#${row.method}`];
    expect(scenario).toBeDefined();
    const outcome = await scenario.run(scenario.tool);
    expect(outcome).toBeInstanceOf(Error);
    expect(isFenceRefusal(outcome) || outcome instanceof SendTargetChangedError).toBe(true);
    expect(changesAfterRefusal()).toEqual([]);
  }, 120_000);
});

describe('INV-catch (static): the rows’ catch throws the refusal on first', () => {
  it('negative control: today’s tree — every row rethrows', () => {
    expect(ROWS.filter((r) => !r.rethrows).map((r) => `${rowName(r)} (line ${r.line})`)).toEqual([]);
  });

  it('positive control: the codex launch wait without its rethrow → red', () => {
    const file = 'src/lib/cli-tools/codex.ts';
    const text = read(file);
    const rethrow = '        rethrowFenceRefusal(error);\n        // Capture may fail during initialization - continue polling\n';
    expect(text.includes(rethrow)).toBe(true);
    const files = new Map(LIB);
    files.set(file, text.replace(rethrow, '        // Capture may fail during initialization - continue polling\n'));
    const rows = driverCatchRows(files, GATED).filter((r) => r.file === file && !r.rethrows);
    expect(rows.map((r) => r.method)).toEqual(['waitForReady']);
  });
});
