/**
 * G9 (Issue #4227, G-PR4; UAT of G-PR3, rejection 3): the request text showed `[--close-when …]` as
 * optional, but `waiting` / `next` / `external` require it (`CLOSE_WHEN_DEFAULTS[kind] === null`), so an
 * agent's first `propose` exited 2. The text now carries, per kind, whether it is required, the types the
 * kind takes and an example — all built from `lib/mem/close-when`, none copied.
 *
 * Positive control: for each kind the example line is taken from the text and run through the real
 * program (`buildProgram`, actions replaced by a recorder) and then through `parseCloseWhen`, the rule the
 * server applies to the proposal: it is accepted (exit 0 = no parse error and an ok draft). Red on the text
 * before this change (it has no per-kind line). Negative control: a required kind without `--close-when`
 * is refused (`required`); a kind that may omit it is not; a type the kind forbids is refused.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { CommanderError, type Command } from 'commander';
import { buildProgram } from '../../../../src/cli/program';
import { CLOSE_WHEN_ALLOWED, CLOSE_WHEN_DEFAULTS, CLOSE_WHEN_TYPES, parseCloseWhen } from '../../../../src/lib/mem/close-when';
import { MEM_KINDS, type MemKind } from '../../../../src/types/mem';
import { CLOSE_WHEN_FORMS, handoffRequestText } from '../../../../src/lib/handoff/template';

const REQUEST = 'req-g9-0002';
const DEADLINE = new Date('2026-11-10T00:05:00.000Z');
const TEXT = handoffRequestText(REQUEST, DEADLINE);
const KINDS = MEM_KINDS.filter((kind): kind is Exclude<MemKind, 'now'> => kind !== 'now');

function kindLine(kind: string): string | undefined {
  return TEXT.split('\n').find((line) => line.startsWith(`- kind=${kind}:`));
}

function exampleOf(kind: string): string | undefined {
  return /例: --close-when (\S+)/.exec(kindLine(kind) ?? '')?.[1];
}

interface Seen {
  kind?: string;
  closeWhen?: string;
}

async function parseThroughCli(words: string[]): Promise<{ seen: Seen[]; error: string | null }> {
  const program = buildProgram();
  const seen: Seen[] = [];
  const errors: string[] = [];
  const walk = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: () => undefined, writeErr: (text) => void errors.push(text) });
    if ((command as unknown as { _actionHandler: unknown })._actionHandler) {
      command.action((...args: unknown[]) => {
        const options = args.find((arg) => typeof arg === 'object' && arg !== null && 'kind' in (arg as object)) as Seen | undefined;
        const own = (args[args.length - 1] as Command).opts() as Seen;
        seen.push({ kind: own.kind ?? options?.kind, closeWhen: own.closeWhen ?? options?.closeWhen });
      });
    }
    command.commands.forEach(walk);
  };
  walk(program);
  try {
    await program.parseAsync(['node', 'commandmate', ...words]);
    return { seen, error: null };
  } catch (error) {
    if (error instanceof CommanderError) return { seen, error: errors.join('') || error.message };
    throw error;
  }
}

/** What the agent would run for a kind: the text's add line, its kind filled, with or without the example. */
function proposeWords(kind: string, closeWhen: string | undefined): string[] {
  const words = ['handoff', 'propose', '--request', REQUEST, 'add', '--kind', kind, '--text', 'x'];
  return closeWhen === undefined ? words : [...words, '--close-when', closeWhen];
}

/** The exit the agent sees: 0 when the CLI parses it and the server's rule takes the condition. */
async function exitOf(kind: string, closeWhen: string | undefined): Promise<number> {
  const { seen, error } = await parseThroughCli(proposeWords(kind, closeWhen));
  if (error !== null || seen.length !== 1) return 2;
  return parseCloseWhen(kind as MemKind, seen[0].closeWhen).ok ? 0 : 2;
}

describe('[#4227 G9 PR4] the request text says which kinds need --close-when, and the values that are taken', () => {
  it.each(KINDS)('%s: the text has its line, with required/optional as the rule has it', (kind) => {
    const line = kindLine(kind);
    expect(line).toBeDefined();
    const required = CLOSE_WHEN_DEFAULTS[kind] === null;
    expect(line).toContain(required ? '必須' : '省略可');
    expect(line).not.toContain(required ? '省略可' : '必須');
    const listed = /使える値: ([^。]+)。/.exec(line!)?.[1].split(' / ') ?? [];
    expect(listed).toEqual(CLOSE_WHEN_TYPES.filter((type) => CLOSE_WHEN_ALLOWED[kind].has(type)));
  });

  it.each(KINDS)('%s: (positive) the example line of the text parses with the real CLI and the rule: exit 0', async (kind) => {
    const example = exampleOf(kind);
    expect(example).toBeDefined();
    expect(await exitOf(kind, example)).toBe(0);
  });

  it.each(KINDS.filter((kind) => CLOSE_WHEN_DEFAULTS[kind] === null))('%s: (negative) required: without --close-when it is refused', async (kind) => {
    expect(await exitOf(kind, undefined)).toBe(2);
    expect(parseCloseWhen(kind, undefined)).toEqual({ ok: false, reason: 'required' });
  });

  it.each(KINDS.filter((kind) => CLOSE_WHEN_DEFAULTS[kind] !== null))('%s: (negative) optional: without --close-when it is still taken', async (kind) => {
    expect(await exitOf(kind, undefined)).toBe(0);
  });

  it('(negative) a type the kind forbids is refused (the text lists only the allowed ones)', async () => {
    expect(await exitOf('decision', 'manual')).toBe(2);
    expect(await exitOf('note', 'issue:#12')).toBe(2);
  });

  it('every type has a form in the text, and the form (filled) is taken by a kind that allows it', () => {
    expect(Object.keys(CLOSE_WHEN_FORMS).sort()).toEqual([...CLOSE_WHEN_TYPES].sort());
    for (const type of CLOSE_WHEN_TYPES) {
      const filled = CLOSE_WHEN_FORMS[type]
        .replace('<n>', '12')
        .replace('<name>', 'feature/x')
        .replace('<into>', 'develop')
        .replace('<ISO8601+09:00>', '2026-11-11T09:00:00+09:00')
        .replace('<id>', 'a1');
      const kind = KINDS.find((k) => CLOSE_WHEN_ALLOWED[k].has(type)) ?? 'now';
      expect(parseCloseWhen(kind, filled).ok).toBe(true);
    }
  });

  it('the deadline of the header is written with +09:00 (an agent read the UTC form as the wrong hour)', () => {
    expect(TEXT).toContain('期限=2026-11-10T09:05:00+09:00');
    expect(TEXT).not.toContain('Z]');
    expect(exampleOf('waiting')).toMatch(/\+09:00$/);
  });
});
