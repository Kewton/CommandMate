/**
 * Issue #4534, G-台帳 (design §5): the terminal changes composed OUTSIDE
 * `tmux.ts` that are not keys (the existing `pane-key-writers.test.ts` ledger
 * holds the key commands and is not changed), and OpenCode's `prompt_async`.
 * A change is EVERY tmux command the closed reads list of design §5 does not
 * name (r7b) — this file spells no change command, so none can be left off a
 * list. Each `file#site` is "gated" — the function that composes it has a
 * fence gate in front of it — or "not a send" with the reason, and holds the
 * number of changes it composes.
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
import { RAW_KEY_COMMANDS, scanLiterals, srcFiles, TMUX_MODULE } from './pane-key-writers-scan';
import { buildTmuxTeardownArgv } from '@/lib/agent-health/tmux-command';

const read = (f: string): string => readFileSync(join(REPO_ROOT, f), 'utf-8');

/** The program's own name in an argv or a shell line. */
const isTmuxProgram = (text: string): boolean => text === 'tmux' || text.endsWith('/tmux');
/** Global flags of tmux that take an argument (`tmux -L <socket> <command> …`). */
const FLAGS_WITH_ARGUMENT: ReadonlySet<string> = new Set(['-L', '-S', '-f', '-c', '-T']);

/**
 * How design §5 reads a tmux command: a read, a buffer command, a key (the
 * existing `pane-key-writers` ledger's), or — everything else, names this file
 * never spells included — a change.
 */
function classifyTmuxCommand(command: string): 'read' | 'buffer' | 'key' | 'change' {
  if (READ_COMMANDS.some((r) => (r.endsWith('*') ? command.startsWith(r.slice(0, -1)) : command === r))) return 'read';
  if (BUFFER_COMMANDS.includes(command)) return 'buffer';
  if (RAW_KEY_COMMANDS.includes(command)) return 'key';
  return 'change';
}

function siteOf(node: ts.Node): string {
  for (let c: ts.Node | undefined = node.parent; c; c = c.parent) {
    if (ts.isFunctionDeclaration(c) && c.name) return c.name.text;
    if (ts.isMethodDeclaration(c) && ts.isIdentifier(c.name)) {
      const owner = c.parent;
      return ts.isClassDeclaration(owner) && owner.name ? `${owner.name.text}.${c.name.text}` : c.name.text;
    }
    if ((ts.isArrowFunction(c) || ts.isFunctionExpression(c)) && ts.isVariableDeclaration(c.parent) && ts.isIdentifier(c.parent.name)) return c.parent.name.text;
  }
  return '<module>';
}

/** The command words of a tmux argv: after the global flags, and after each `;`. A non-literal there is a command nobody can read. */
function argvCommandWords(array: ts.ArrayLiteralExpression): string[] {
  let elements = [...array.elements];
  const head = elements[0];
  if (head !== undefined && ts.isStringLiteralLike(head) && isTmuxProgram(head.text)) elements = elements.slice(1);
  const words: string[] = [];
  let expect = true;
  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i];
    const literal = ts.isStringLiteralLike(element) ? element.text : null;
    if (!expect) {
      if (literal === ';' || literal === '\;') expect = true;
      continue;
    }
    if (ts.isSpreadElement(element)) continue;
    if (literal === null) {
      words.push('<unreadable>');
      expect = false;
      continue;
    }
    if (FLAGS_WITH_ARGUMENT.has(literal)) {
      i += 1;
      continue;
    }
    // `tmux -V` asks the version: the flag is the whole command.
    if (literal === '-V') {
      words.push(literal);
      break;
    }
    if (literal.startsWith('-')) continue;
    words.push(literal);
    expect = false;
  }
  return words;
}

const calleeText = (e: ts.Expression): string | null => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null);

/**
 * Every tmux command word one file composes: an argv handed to tmux (its program
 * named, or a callee that says tmux), an argv that starts with the program or —
 * inside a function that says tmux — with a global flag, a shell line
 * `tmux [flags] <word>`, and a control-mode line written to a client's stdin.
 */
function tmuxCommandWords(file: string, text: string): Array<{ site: string; line: number; command: string }> {
  if (!/tmux|stdin/.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ site: string; line: number; command: string }> = [];
  const add = (node: ts.Node, command: string): void => {
    found.push({ site: siteOf(node), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, command });
  };
  const literalText = (node: ts.Node): string | null =>
    ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => `\u0000${span.literal.text}`).join('') : null;
  const shellLine = /(?:^|[\s;&|(`'"])tmux(?:\s+-[A-Za-z0-9]+(?:\s+(?!-)[^\s;]+)?)*\s+([A-Za-z][A-Za-z0-9-]*)(?=[\s;'"`]|$)/g;
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const parent = node.parent;
      const head = node.elements[0];
      const toTmux =
        (ts.isCallExpression(parent) && parent.arguments.includes(node) &&
          ((parent.arguments[0] !== undefined && ts.isStringLiteralLike(parent.arguments[0]) && isTmuxProgram(parent.arguments[0].text)) ||
            /tmux/i.test(calleeText(parent.expression) ?? ''))) ||
        (head !== undefined && ts.isStringLiteralLike(head) && isTmuxProgram(head.text)) ||
        (head !== undefined && ts.isStringLiteralLike(head) && FLAGS_WITH_ARGUMENT.has(head.text) && /tmux/i.test(siteOf(node)));
      if (toTmux) for (const word of argvCommandWords(node)) add(node, word);
    } else {
      const textOf = literalText(node);
      if (textOf !== null) {
        for (const m of textOf.matchAll(shellLine)) add(node, m[1]);
        // A control-mode line: a literal written to a tmux client's stdin.
        const call = node.parent;
        if (ts.isCallExpression(call) && call.arguments[0] === node && ts.isPropertyAccessExpression(call.expression)
          && call.expression.name.text === 'write' && /\bstdin$/.test(call.expression.expression.getText(source))) {
          const word = /^([A-Za-z][A-Za-z0-9-]*)/.exec(textOf);
          if (word) add(node, word[1]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

type Row = { kind: 'gated'; count: number } | { kind: 'not-a-send'; count: number; reason: string };

/** `file#site` → how its changes are held, and how many it composes. Today's tree, all of it. */
const LEDGER: Readonly<Record<string, Row>> = {
  'src/app/manifest.ts#manifest': { kind: 'not-a-send', count: 1, reason: "text shown in the browser" },
  'src/cli/commands/attach.ts#planGuardedAttach': { kind: 'not-a-send', count: 4, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/cli/commands/attach.ts#buildAttachHints': { kind: 'not-a-send', count: 3, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/cli/commands/attach.ts#attachOrSwitch': { kind: 'not-a-send', count: 1, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/cli/commands/attach.ts#createAttachCommand': { kind: 'not-a-send', count: 2, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/cli/commands/capture.ts#createCaptureCommand': { kind: 'not-a-send', count: 1, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/cli/commands/whoami.ts#describeSource': { kind: 'not-a-send', count: 1, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/cli/commands/whoami.ts#<module>': { kind: 'not-a-send', count: 1, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/cli/docs/agent-operations.ts#<module>': { kind: 'not-a-send', count: 1, reason: "CLI documentation text" },
  'src/cli/docs/setup-guide.ts#<module>': { kind: 'not-a-send', count: 2, reason: "CLI documentation text" },
  'src/cli/docs/team-setup-guide.ts#<module>': { kind: 'not-a-send', count: 2, reason: "CLI documentation text" },
  'src/cli/program.ts#buildProgram': { kind: 'not-a-send', count: 1, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/cli/utils/api-client-errors.ts#foreignSessionMessage': { kind: 'not-a-send', count: 1, reason: "a CLI process: its own messages and the attach line it shows or runs in a person’s terminal" },
  'src/components/Terminal.tsx#TerminalComponent': { kind: 'not-a-send', count: 1, reason: "text shown in the browser" },
  'src/lib/agent-health/tmux-command.ts#buildTmuxArgv': { kind: 'not-a-send', count: 2, reason: "the agent-health run’s own private tmux server (-L cm-agent-health), a separate process" },
  'src/lib/agent-health/tmux-command.ts#buildTmuxTeardownArgv': { kind: 'not-a-send', count: 1, reason: "the agent-health run’s own private tmux server (-L cm-agent-health), a separate process" },
  'src/lib/agent-health/tmux-command.ts#exactSessionTarget': { kind: 'not-a-send', count: 1, reason: "the agent-health run’s own private tmux server (-L cm-agent-health), a separate process" },
  'src/lib/agent-roles/pane-env.ts#tmuxPaneLaunchCwdReader': { kind: 'not-a-send', count: 1, reason: "message text that names tmux (no invocation)" },
  'src/lib/cli-tools/opencode-v2.ts#OpenCodeV2Tool.launchSession': { kind: 'gated', count: 1 },
  'src/lib/cli-tools/opencode.ts#OpenCodeTool.launchSession': { kind: 'gated', count: 1 },
  'src/lib/hooks/hook-settings-generator.ts#<module>': { kind: 'not-a-send', count: 2, reason: "text of an agent permission pattern / hook command the agent runs" },
  'src/lib/hooks/sources/opencode/client.ts#sendOpencodePrompt': { kind: 'gated', count: 1 },
  'src/lib/session/claude-session.ts#<module>': { kind: 'not-a-send', count: 2, reason: "message text that names tmux (no invocation)" },
  'src/lib/session/claude-session.ts#startClaudeSession': { kind: 'gated', count: 1 },
  'src/lib/session/send-user-message.ts#sendUserMessage': { kind: 'not-a-send', count: 2, reason: "message text that names tmux (no invocation)" },
  'src/lib/session/session-launch-flight.ts#<module>': { kind: 'not-a-send', count: 4, reason: "message text that names tmux (no invocation)" },
  'src/lib/session/session-start-error.ts#<module>': { kind: 'not-a-send', count: 2, reason: "message text that names tmux (no invocation)" },
  'src/lib/session/session-start-error.ts#buildSessionExitedToShellMessage': { kind: 'not-a-send', count: 1, reason: "message text that names tmux (no invocation)" },
  'src/lib/tmux/read-mode-pager.ts#<module>': { kind: 'not-a-send', count: 2, reason: "text of a script tmux runs itself (a hook, the read-mode pager)" },
  'src/lib/tmux/session-hook-scripts.ts#<module>': { kind: 'not-a-send', count: 7, reason: "text of a script tmux runs itself (a hook, the read-mode pager)" },
  'src/lib/tmux/session-ownership.ts#<module>': { kind: 'not-a-send', count: 1, reason: "message text that names tmux (no invocation)" },
  'src/lib/tmux/session-ownership.ts#foreignSessionErrorBody': { kind: 'not-a-send', count: 1, reason: "message text that names tmux (no invocation)" },
  'src/lib/tmux/tmux-control-client.ts#TmuxControlClient.start': { kind: 'not-a-send', count: 1, reason: "an error message of the viewer’s control-mode client" },
  'src/lib/tmux/tmux-control-client.ts#TmuxControlClient.resize': { kind: 'not-a-send', count: 1, reason: "the terminal viewer's control-mode client sizes itself (a person's screen, §2.4)" },
  'src/lib/verification/env-snapshot.ts#<module>': { kind: 'not-a-send', count: 1, reason: "message text that names tmux (no invocation)" },
  'src/lib/verification/env-snapshot.ts#captureEnvSnapshot': { kind: 'not-a-send', count: 1, reason: "message text that names tmux (no invocation)" },
};

/** Where the gate of a `gated` row stands, when it is not in the composing function itself. */
const GATED_BY: Readonly<Record<string, { file: string; site: string; gate: string }>> = {
  'src/lib/hooks/sources/opencode/client.ts#sendOpencodePrompt': {
    file: 'src/lib/cli-tools/opencode.ts',
    site: 'OpenCodeTool.dispatchViaServer',
    gate: "fenceGate('dispatch')",
  },
};

/** `file#site` → the lines of its changes (tmux commands the reads list does not name, and `prompt_async`). */
function ledgerRows(files: ReadonlyMap<string, string>): Map<string, number[]> {
  const rows = new Map<string, number[]>();
  const add = (row: string, line: number): void => {
    rows.set(row, [...(rows.get(row) ?? []), line]);
  };
  for (const [f, text] of files) {
    if (f === TMUX_MODULE) continue;
    for (const w of tmuxCommandWords(f, text)) if (classifyTmuxCommand(w.command) === 'change') add(`${f}#${w.site}`, w.line);
    for (const l of scanLiterals(f, text, (literal) => literal.includes('/prompt_async'))) add(`${l.file}#${l.site}`, l.line);
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
    if (lines.length !== held.count) v.push(`a ledger row whose changes are not the ones held: ${row} (${lines.length}, held ${held.count})`);
    if (held.kind !== 'gated') continue;
    const at = GATED_BY[row];
    const [file, site] = at ? [at.file, at.site] : [row.slice(0, row.indexOf('#')), row.slice(row.indexOf('#') + 1)];
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
    files.set('src/lib/zz-raw.ts', "import { execFile, exec } from 'child_process';\nexport function a(): void { execFile('tmux', ['frobnicate-window', '-t', 'x']); }\nexport function b(): void { exec('tmux frobnicate-env -g FOO 1'); }\n");
    const claude = 'src/lib/session/claude-session.ts';
    files.set(claude, (files.get(claude) ?? '').replace("    fenceGate('env');\n", ''));
    expect(ledgerViolations(files)).toEqual([
      'a gated row lost its gate: src/lib/session/claude-session.ts#startClaudeSession',
      'a terminal change no ledger row holds: src/lib/zz-raw.ts#a (line 2)',
      'a terminal change no ledger row holds: src/lib/zz-raw.ts#b (line 3)',
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

