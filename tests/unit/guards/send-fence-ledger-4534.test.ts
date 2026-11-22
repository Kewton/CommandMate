/**
 * Issue #4534, G-台帳 (design §5): the terminal changes composed OUTSIDE
 * `tmux.ts` that are not keys (the existing `pane-key-writers.test.ts` ledger
 * holds `send-keys` / `paste-buffer` and is not changed), and OpenCode's
 * `prompt_async`. Each row is "gated" — the function that composes it has a
 * fence gate in front of it — or "not a send" with the reason.
 *
 * And R2 statically: between a gate and the process call it guards there is no
 * `await` (the gate's permit and the spawn are one synchronous step). A HELPER
 * of the run-time G-境: the process calls it knows are `execFileAsync`,
 * `execAsync`, the sender's `runTmux` and `sendOpencodePrompt`.
 *
 * In-memory trees only; no repository file is written.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './route-tmux-reach';
import { scanLiterals, scanRawTmuxCommands, srcFiles, TMUX_MODULE, type TmuxCommandSet } from './pane-key-writers-scan';
import { buildTmuxTeardownArgv } from '@/lib/agent-health/tmux-command';

const read = (f: string): string => readFileSync(join(REPO_ROOT, f), 'utf-8');

/** tmux commands that change a session, window, pane, client or the server — keys aside. */
const CHANGE_SET: TmuxCommandSet = {
  commands: [
    'new-session', 'new-window', 'respawn-pane', 'respawn-window', 'resize-window', 'resize-pane', 'set-option', 'set-window-option',
    'set-environment', 'set-hook', 'set-buffer', 'kill-session', 'kill-server', 'kill-window', 'kill-pane', 'rename-session',
    'rename-window', 'refresh-client', 'split-window', 'select-pane', 'select-window', 'pipe-pane', 'swap-pane', 'break-pane',
    'join-pane', 'move-window', 'unlink-window', 'source-file', 'run-shell', 'if-shell', 'clear-history', 'detach-client',
    'switch-client', 'attach-session', 'rotate-window',
  ],
  aliases: {
    new: 'new-session', neww: 'new-window', respawnp: 'respawn-pane', resizew: 'resize-window', resizep: 'resize-pane',
    set: 'set-option', setw: 'set-window-option', setenv: 'set-environment', rename: 'rename-session', refresh: 'refresh-client',
    splitw: 'split-window', killw: 'kill-window', killp: 'kill-pane',
  },
};

type Row = { kind: 'gated' } | { kind: 'not-a-send'; reason: string };

/** `command <- file#site` → how it is held. Today's tree, all of it. */
const LEDGER: Readonly<Record<string, Row>> = {
  'resize-window <- src/lib/cli-tools/opencode.ts#OpenCodeTool.launchSession': { kind: 'gated' },
  'resize-window <- src/lib/cli-tools/opencode-v2.ts#OpenCodeV2Tool.launchSession': { kind: 'gated' },
  'set-environment <- src/lib/session/claude-session.ts#startClaudeSession': { kind: 'gated' },
  'prompt_async <- src/lib/hooks/sources/opencode/client.ts#sendOpencodePrompt': { kind: 'gated' },
  'refresh-client <- src/lib/tmux/tmux-control-client.ts#TmuxControlClient.resize': {
    kind: 'not-a-send',
    reason: "the terminal viewer's control-mode client sizes itself (a person's screen, §2.4)",
  },
  'resize-window <- src/lib/tmux/session-hook-scripts.ts#<module>': { kind: 'not-a-send', reason: 'text of a tmux hook script tmux runs itself' },
  'set-option <- src/lib/tmux/session-hook-scripts.ts#<module>': { kind: 'not-a-send', reason: 'text of a tmux hook script tmux runs itself' },
  'set-window-option <- src/lib/tmux/session-hook-scripts.ts#<module>': { kind: 'not-a-send', reason: 'text of a tmux hook script tmux runs itself' },
  'set-option <- src/lib/hooks/hook-settings-generator.ts#<module>': { kind: 'not-a-send', reason: "text of an agent hook command the agent runs" },
  'run-shell <- src/lib/session/tmux-session-surface.ts#buildHookRunShellBody': { kind: 'not-a-send', reason: 'text of a tmux hook body tmux runs itself' },
};

/** Where the gate of a `gated` row stands, when it is not in the composing function itself. */
const GATED_BY: Readonly<Record<string, { file: string; site: string; gate: string }>> = {
  'prompt_async <- src/lib/hooks/sources/opencode/client.ts#sendOpencodePrompt': {
    file: 'src/lib/cli-tools/opencode.ts',
    site: 'OpenCodeTool.dispatchViaServer',
    gate: "fenceGate('dispatch')",
  },
};

function ledgerRows(files: ReadonlyMap<string, string>): Map<string, number[]> {
  const rows = new Map<string, number[]>();
  const add = (row: string, line: number): void => {
    rows.set(row, [...(rows.get(row) ?? []), line]);
  };
  for (const [f, text] of files) {
    if (f === TMUX_MODULE) continue;
    for (const w of scanRawTmuxCommands(f, text, CHANGE_SET)) add(`${w.command} <- ${w.file}#${w.site}`, w.line);
    for (const l of scanLiterals(f, text, (literal) => literal.includes('/prompt_async'))) add(`prompt_async <- ${l.file}#${l.site}`, l.line);
  }
  return rows;
}

/** The text of the function `site` in `text` (`Class.method` or a free function / const arrow). */
function functionText(file: string, text: string, site: string): string | null {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const [owner, name] = site.includes('.') ? site.split('.') : [null, site];
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (owner === null && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source);
    if (owner === null && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node.getText(source);
    if (owner !== null && ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const cls = node.parent;
      if (ts.isClassDeclaration(cls) && cls.name?.text === owner) found = node.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function ledgerViolations(files: ReadonlyMap<string, string>): string[] {
  const v: string[] = [];
  const rows = ledgerRows(files);
  for (const [row, lines] of rows) {
    const held = LEDGER[row];
    if (held === undefined) {
      v.push(`a terminal change no ledger row holds: ${row} (line ${lines.join(', ')})`);
      continue;
    }
    if (held.kind !== 'gated') continue;
    const at = GATED_BY[row];
    const [file, site] = at ? [at.file, at.site] : [row.slice(row.indexOf('<- ') + 3, row.indexOf('#')), row.slice(row.indexOf('#') + 1)];
    const body = functionText(file, files.get(file) ?? '', site);
    if (body === null || !(at ? body.includes(at.gate) : /\bfenceGate\(/.test(body))) v.push(`a gated row lost its gate: ${row}`);
  }
  for (const row of Object.keys(LEDGER)) if (!rows.has(row)) v.push(`a ledger row with nothing behind it: ${row}`);
  return v.sort();
}

// ---------------------------------------------------------------------------
// R2: no `await` between a gate and its process call
// ---------------------------------------------------------------------------

const GATES = new Set(['fenceGate', 'fenceBatchOpen', 'fenceBatchStep']);
const SPAWNERS = new Set(['execFileAsync', 'execAsync', 'runTmux', 'sendOpencodePrompt']);

const calleeName = (call: ts.CallExpression): string | null => (ts.isIdentifier(call.expression) ? call.expression.text : null);
const unwrapParens = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrapParens(e.expression) : e);

function awaitBetweenGateAndSpawn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bad: string[] = [];
  const lineOf = (n: ts.Node): number => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const enclosingFunction = (n: ts.Node): ts.Node | null => {
    for (let c: ts.Node | undefined = n.parent; c; c = c.parent) if (ts.isFunctionLike(c)) return c;
    return null;
  };
  const inOrder = (root: ts.Node): ts.Node[] => {
    const out: ts.Node[] = [];
    const walk = (n: ts.Node): void => {
      // A catch clause is not the way the step goes on when the gate passed.
      if (ts.isCatchClause(n)) return;
      out.push(n);
      ts.forEachChild(n, walk);
    };
    walk(root);
    return out;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && GATES.has(calleeName(node) ?? '')) {
      const fn = enclosingFunction(node);
      const nodes = fn === null ? [] : inOrder(fn).filter((n) => n.getStart(source) >= node.getEnd());
      const spawn = nodes.find((n): n is ts.CallExpression => ts.isCallExpression(n) && SPAWNERS.has(calleeName(n) ?? ''));
      if (spawn === undefined) {
        bad.push(`${file}:${lineOf(node)} ${calleeName(node)} has no process call after it`);
      } else {
        const awaits = nodes.filter(
          (n) => ts.isAwaitExpression(n) && n.getStart(source) < spawn.getStart(source) && unwrapParens(n.expression) !== spawn,
        );
        for (const a of awaits) bad.push(`${file}:${lineOf(node)} ${calleeName(node)}: an await at line ${lineOf(a)} before its process call`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bad;
}

function gatedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const f of srcFiles()) {
    const text = read(f);
    if (f !== 'src/lib/session/terminal-fence.ts' && /\bfence(Gate|BatchOpen|BatchStep)\(/.test(text)) files.set(f, text);
  }
  return files;
}

describe('G-台帳: terminal changes outside tmux.ts that are not keys, and prompt_async', () => {
  it('negative control: today’s rows are the ledger’s rows, and every gated row has its gate', () => {
    const files = new Map(srcFiles().map((f) => [f, read(f)] as const));
    expect(ledgerViolations(files)).toEqual([]);
    expect([...ledgerRows(files).keys()].sort()).toEqual(Object.keys(LEDGER).sort());
  });

  it('positive controls: a new raw change (argv and shell line) / a gated row without its gate → red', () => {
    const files = new Map(srcFiles().map((f) => [f, read(f)] as const));
    files.set('src/lib/zz-raw.ts', "import { execFile, exec } from 'child_process';\nexport function a(): void { execFile('tmux', ['kill-window', '-t', 'x']); }\nexport function b(): void { exec('tmux set-environment -g FOO 1'); }\n");
    const claude = 'src/lib/session/claude-session.ts';
    files.set(claude, (files.get(claude) ?? '').replace("    fenceGate('env');\n", ''));
    expect(ledgerViolations(files)).toEqual([
      'a gated row lost its gate: set-environment <- src/lib/session/claude-session.ts#startClaudeSession',
      'a terminal change no ledger row holds: kill-window <- src/lib/zz-raw.ts#a (line 2)',
      'a terminal change no ledger row holds: set-environment <- src/lib/zz-raw.ts#b (line 3)',
    ]);
  });
});

describe('R2 (static): no await between a gate and the process call it guards', () => {
  it('negative control: every gate in src is followed, in the same step, by its process call', () => {
    const files = gatedFiles();
    expect([...files.keys()].sort()).toEqual([
      'src/lib/cli-tools/opencode-v2.ts',
      'src/lib/cli-tools/opencode.ts',
      'src/lib/cli-tools/submit-verified-sender.ts',
      'src/lib/session/claude-session.ts',
      'src/lib/tmux/tmux.ts',
    ]);
    expect([...files].flatMap(([f, text]) => awaitBetweenGateAndSpawn(f, text))).toEqual([]);
  });

  it('positive control: an await put between a gate and its call → red', () => {
    const file = TMUX_MODULE;
    const mutated = read(file).replace("  fenceGate('kill');\n", "  fenceGate('kill');\n  await Promise.resolve();\n");
    expect(awaitBetweenGateAndSpawn(file, mutated).join('\n')).toMatch(/fenceGate: an await at line \d+ before its process call/);
    const sender = 'src/lib/cli-tools/opencode.ts';
    const moved = read(sender).replace("      fenceGate('dispatch');\n      const dispatch = await sendOpencodePrompt(", "      fenceGate('dispatch');\n      await this.verifyPostedMessage(port, sessionId, messageId, message);\n      const dispatch = await sendOpencodePrompt(");
    expect(moved).not.toBe(read(sender));
    expect(awaitBetweenGateAndSpawn(sender, moved).join('\n')).toMatch(/an await at line \d+ before its process call/);
  });
});

// ---------------------------------------------------------------------------
// r7b: a change is every tmux command the reads list does not name (design §5)
// ---------------------------------------------------------------------------

/**
 * The closed reads list of design §5 (G-境 and G-台帳 share it): these, and
 * nothing else, change nothing. `*` is any rest of the name. Adding one is a
 * change of this list, which the design's own line below must say first.
 */
export const READ_COMMANDS: readonly string[] = ['has-session', 'capture-pane', 'display-message', 'list-*', 'show-*', '-V'];
/** Commands that touch only the server's paste buffers, never a pane (design §5). */
export const BUFFER_COMMANDS: readonly string[] = ['load-buffer', 'delete-buffer'];

/** A sample command name each entry of a list stands for (`list-*` → `list-x`). */
const sampleOf = (entry: string): string => (entry.endsWith('*') ? `${entry.slice(0, -1)}x` : entry);
/** The program's own teardown command, read off production — this file spells no such name. */
const TEARDOWN = buildTmuxTeardownArgv()[buildTmuxTeardownArgv().length - 1];

describe('r7b: a terminal change is every tmux command the reads list does not name', () => {
  const withFile = (text: string): Map<string, string> => {
    const files = new Map(srcFiles().map((f) => [f, read(f)] as const));
    files.set('src/lib/zz-ledger-r7b.ts', text);
    return files;
  };
  const rowsOf = (files: ReadonlyMap<string, string>): string[] => [...ledgerRows(files).keys()].filter((k) => k.includes('src/lib/zz-ledger-r7b.ts'));

  it('[r7b] (a) a command no list names, and the program’s own teardown (from production), are changes', () => {
    const files = withFile(
      "import { execFile, exec } from 'child_process';\n" +
        "export function unknownCommand(): void { execFile('tmux', ['frobnicate-pane', '-t', 'x']); }\n" +
        `export function teardown(): void { execFile('tmux', ['-L', 'private', '${TEARDOWN}']); }\n` +
        "export function shellLine(): void { exec('tmux frobnicate-window -t x'); }\n",
    );
    expect(rowsOf(files)).toHaveLength(3);
  });

  it('[r7b] (b) the reads and the buffer commands are not changes', () => {
    const lines = [...READ_COMMANDS, ...BUFFER_COMMANDS].map((c, i) => `export function r${i}(): void { execFile('tmux', ['${sampleOf(c)}', '-t', 'x']); }`);
    const files = withFile(["import { execFile } from 'child_process';", ...lines, ''].join('\n'));
    expect(rowsOf(files)).toEqual([]);
  });

  it('[r7b] (c) the reads list is the closed list of design §5 (one added here, or there, is red)', () => {
    const design = read('docs/design/send-fence-4534.md');
    const line = design.split('\n').find((l) => l.startsWith('**読みの一覧（G-境・G-台帳で共通）**')) ?? '';
    const reads = line.slice(0, line.indexOf('は読み'));
    const buffers = line.slice(line.indexOf('は読み'), line.indexOf('は buffer だけ'));
    const ticked = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(ticked(reads)).toEqual([...READ_COMMANDS]);
    expect(ticked(buffers)).toEqual([...BUFFER_COMMANDS]);
  });
});

