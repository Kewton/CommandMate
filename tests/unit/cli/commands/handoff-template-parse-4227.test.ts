/**
 * G9 (Issue #4227, the UAT of G-PR1+G-PR2; design `mem-ui-4227.md` §4.2): the request text the
 * screen sends the agent, and the CLI guide, give command lines the agent types as they are. On
 * 46cbe7699 the text's `handoff propose --request <id> add …` was refused by the CLI
 * (`unknown option '--request'`): the agent's proposals never arrived.
 *
 * The invariant: **every `commandmate …` command line of the request text
 * (`handoffRequestText`) and of the guide's `commandmate handoff` block (ja and en) is parsed by
 * the real program (`buildProgram`)** — to the command it names, and for the hand-off with the
 * request id it carries. The lines are taken from the text, not copied here, so a line added to
 * the text (or the guide) is checked too. Actions are replaced by a recorder: nothing is sent.
 *
 * Positive control: the program as it was (the request only after the operation, the `propose`
 * command without `--request`) refuses the text's lines (the control below rebuilds that shape in
 * memory). Negative controls: a misspelt option is refused by the same parse (the recorder does
 * not hide errors); `propose add --request <id>` (the order the UAT found working) still parses.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { Command, CommanderError, type Option } from 'commander';
import { buildProgram } from '../../../../src/cli/program';
import { handoffRequestOf } from '../../../../src/cli/commands/handoff';
import { handoffRequestText } from '../../../../src/lib/handoff/template';

const REQUEST = 'req-g9-0001';
const ROOT = path.resolve(__dirname, '../../../..');

/** The placeholders of the text and the guide, filled as an agent would. */
function fill(line: string): string {
  return line
    .replace(/"…"/g, '"x"')
    .replace(/…/g, 'x')
    .replace(/<kind>/g, 'note')
    .replace(/<itemId>/g, 'item-1')
    .replace(/<v>/g, '1')
    .replace(/<id>/g, REQUEST)
    .replace(/[[\]]/g, '');
}

/**
 * Every `commandmate …` command in `text`: from the word to the end of its line, or to where the
 * prose takes over — outside double quotes, a backtick, `。`/`、`, or a space before a non-ASCII
 * word (`… で`). pr3c (review B P3-2): a quoted argument in another script (`--text "日本語"`) stays
 * whole — the command is no longer cut at its first non-ASCII character.
 */
function commandEnd(rest: string): number {
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === '`' || c === '。' || c === '、') return i;
    // eslint-disable-next-line no-control-regex
    if (/\s/.test(c) && i + 1 < rest.length && /[^\x00-\x7f]/.test(rest[i + 1])) return i;
  }
  return rest.length;
}

function commandsIn(text: string): string[] {
  const found: string[] = [];
  for (const raw of text.split('\n')) {
    const line = fill(raw);
    let at = line.indexOf('commandmate ');
    while (at !== -1) {
      const rest = line.slice(at);
      found.push(rest.slice(0, commandEnd(rest)).trim());
      at = line.indexOf('commandmate ', at + 1);
    }
  }
  return found;
}

/** A minimal shell split: whitespace, and double quotes. */
function argv(command: string): string[] {
  return (command.match(/"[^"]*"|\S+/g) ?? []).map((word) => (word.startsWith('"') ? word.slice(1, -1) : word));
}

/** The guide's `commandmate handoff` lines (its fenced block). */
function guideLines(file: string): string[] {
  const text = readFileSync(path.join(ROOT, file), 'utf-8');
  return text.split('\n').filter((line) => line.startsWith('commandmate handoff '));
}

interface Parsed {
  path: string;
  request: string | undefined;
}

/** The program with every action replaced by a recorder, every error thrown (not exited). */
function recordingProgram(shape?: (program: Command) => void): { program: Command; ran: Parsed[]; errors: string[] } {
  const program = buildProgram();
  const ran: Parsed[] = [];
  const errors: string[] = [];
  const walk = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: () => undefined, writeErr: (text) => void errors.push(text) });
    if ((command as unknown as { _actionHandler: unknown })._actionHandler) {
      command.action((...args: unknown[]) => {
        const self = args[args.length - 1] as Command;
        const names: string[] = [];
        for (let at: Command | null = self; at; at = at.parent) names.unshift(at.name());
        ran.push({ path: names.slice(1).join(' '), request: handoffRequestOf(self) });
      });
    }
    command.commands.forEach(walk);
  };
  walk(program);
  shape?.(program);
  return { program, ran, errors };
}

async function parse(command: string, shape?: (program: Command) => void): Promise<{ ran: Parsed[]; error: string | null }> {
  const { program, ran, errors } = recordingProgram(shape);
  const words = argv(command);
  expect(words[0]).toBe('commandmate');
  try {
    await program.parseAsync(['node', 'commandmate', ...words.slice(1)]);
    return { ran, error: null };
  } catch (error) {
    if (error instanceof CommanderError) return { ran, error: errors.join('') || error.message };
    throw error;
  }
}

const TEXT_LINES = commandsIn(handoffRequestText(REQUEST, new Date('2026-11-10T00:05:00.000Z')));
const GUIDE_LINES = [...guideLines('docs/user-guide/cli-operations-guide.md'), ...guideLines('docs/en/user-guide/cli-operations-guide.md')].map(fill);

/** The command a line names: the words before its first option or operand. */
function namedPath(command: string): string {
  const words = argv(command).slice(1);
  const names: string[] = [];
  for (const word of words) {
    if (word.startsWith('-')) {
      // `propose --request <id> add`: the request stands between the command and its operation.
      if (word === '--request') continue;
      break;
    }
    if (word === REQUEST) continue;
    if (!/^[a-z-]+$/.test(word)) break;
    names.push(word);
  }
  return names.join(' ');
}

describe('[#4227 G9] every command line of the request text and the guide parses with the real CLI', () => {
  it('the text and the guide have the lines (not an empty check)', () => {
    // propose add / update / close, done, mem list.
    expect(TEXT_LINES.length).toBeGreaterThanOrEqual(5);
    expect(TEXT_LINES.filter((line) => line.startsWith('commandmate handoff propose --request '))).toHaveLength(3);
    expect(TEXT_LINES).toContain(`commandmate handoff done --request ${REQUEST}`);
    expect(GUIDE_LINES).toHaveLength(8);
  });

  it('pr3c (B P3-2): a line is taken to its end, a quoted argument in another script kept whole', () => {
    expect(commandsIn('- 追加: commandmate handoff propose --request R add --kind note --text "日本語の例、です" で出す')).toEqual([
      'commandmate handoff propose --request R add --kind note --text "日本語の例、です"',
    ]);
    expect(commandsIn('`commandmate mem list --all` を読む。')).toEqual(['commandmate mem list --all']);
    expect(commandsIn('- 終わったら: commandmate handoff done --request R')).toEqual(['commandmate handoff done --request R']);
  });

  it.each([...TEXT_LINES.map((line) => ['text', line]), ...GUIDE_LINES.map((line) => ['guide', line])])(
    '%s: %s',
    async (_from, line) => {
      const { ran, error } = await parse(line);
      expect(error).toBeNull();
      expect(ran).toHaveLength(1);
      expect(ran[0].path).toBe(namedPath(line));
      if (ran[0].path.startsWith('handoff ')) expect(ran[0].request).toBe(REQUEST);
    }
  );

  it('(positive control) the program before G9 — `propose` without --request — refuses the text’s propose lines', async () => {
    const before = (program: Command) => {
      const propose = program.commands.find((c) => c.name() === 'handoff')!.commands.find((c) => c.name() === 'propose')!;
      const at = propose.options.findIndex((option) => option.long === '--request');
      expect(at).toBeGreaterThanOrEqual(0);
      (propose.options as Option[]).splice(at, 1);
    };
    const proposeLines = TEXT_LINES.filter((line) => line.includes(' propose '));
    expect(proposeLines).toHaveLength(3);
    for (const line of proposeLines) {
      const { ran, error } = await parse(line, before);
      expect(error).toMatch(/unknown option '--request'/);
      expect(ran).toEqual([]);
    }
  });

  it('(negative control) a misspelt option is refused by the same parse', async () => {
    const { ran, error } = await parse(`commandmate handoff propose --requets ${REQUEST} add --kind note --text x`);
    expect(error).toMatch(/unknown option '--requets'/);
    expect(ran).toEqual([]);
  });

  it('(negative control) the request after the operation still parses, to the same request', async () => {
    for (const op of ['add --kind note --text x', 'update item-1 --base-version 1 --text x', 'close item-1 --base-version 1']) {
      const [name] = op.split(' ');
      const { ran, error } = await parse(`commandmate handoff propose ${op} --request ${REQUEST}`);
      expect(error).toBeNull();
      expect(ran).toEqual([{ path: `handoff propose ${name}`, request: REQUEST }]);
    }
  });
});
