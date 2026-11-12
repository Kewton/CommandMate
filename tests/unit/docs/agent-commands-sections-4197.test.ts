/**
 * Issue #4197: the four commands agents use to talk to each other
 * (`whoami` / `peers` / `ask` / `relays`) each have their own `##` section in
 * the CLI Operations Guide (ja and en), and every flag the command registers
 * is written in it. The flags are read from the commander program itself, so a
 * flag added to a command without a word in the guide turns this red.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { createAskCommand } from '@/cli/commands/ask';
import { createPeersCommand } from '@/cli/commands/peers';
import { createRelaysCommand } from '@/cli/commands/relays';
import { createWhoamiCommand } from '@/cli/commands/whoami';
import { AGENT_OPERATIONS_GUIDE } from '@/cli/docs/agent-operations';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const GUIDES = {
  ja: fs.readFileSync(path.join(REPO_ROOT, 'docs/user-guide/cli-operations-guide.md'), 'utf-8'),
  en: fs.readFileSync(path.join(REPO_ROOT, 'docs/en/user-guide/cli-operations-guide.md'), 'utf-8'),
};

const COMMANDS: ReadonlyArray<{ name: string; make: () => Command }> = [
  { name: 'whoami', make: createWhoamiCommand },
  { name: 'peers', make: createPeersCommand },
  { name: 'ask', make: createAskCommand },
  { name: 'relays', make: createRelaysCommand },
];

/** The `## commandmate <name>` section: up to the next `## ` heading. */
export function sectionOf(doc: string, name: string): string | null {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l === `## commandmate ${name}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** Long flags (and subcommand names) the command registers, recursively. */
export function surfaceOf(cmd: Command): string[] {
  const own = cmd.options.map((o) => o.long).filter((f): f is string => !!f && f !== '--help');
  const subs = cmd.commands.flatMap((c) => [c.name(), ...surfaceOf(c)]);
  return [...own, ...subs];
}

/** What the section does not mention. */
export function missingFrom(section: string, surface: string[]): string[] {
  return surface.filter((s) => !section.includes(s));
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('every registered flag is written in its own section (Issue #4197)', () => {
  for (const lang of ['ja', 'en'] as const) {
    for (const { name, make } of COMMANDS) {
      it(`${lang}: "## commandmate ${name}" exists and names every flag`, () => {
        const section = sectionOf(GUIDES[lang], name);
        expect(section).not.toBeNull();
        expect(missingFrom(section as string, surfaceOf(make()))).toEqual([]);
      });
    }
  }

  it('positive control: a section missing a flag is reported', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4197-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'guide.md');
    fs.writeFileSync(file, '## commandmate ask\n\n--timeout --json\n\n## commandmate prompt\n');
    const section = sectionOf(fs.readFileSync(file, 'utf-8'), 'ask') as string;
    expect(missingFrom(section, surfaceOf(createAskCommand()))).toContain('--async');
    expect(missingFrom(section, surfaceOf(createAskCommand()))).not.toContain('--json');
  });

  it('negative control: the wait section is not mistaken for the ask section', () => {
    expect(sectionOf('## commandmate wait\n--async\n', 'ask')).toBeNull();
  });
});

describe('command list and exit codes (Issue #4197)', () => {
  for (const lang of ['ja', 'en'] as const) {
    it(`${lang}: the command table links all four`, () => {
      for (const { name } of COMMANDS) {
        expect(GUIDES[lang]).toContain(`[\`commandmate ${name}\`](#commandmate-${name})`);
      }
    });
  }

  it('ja/en: the final exit-code table has 3 NOT_IN_SESSION and 11 / 32 for ask', () => {
    for (const lang of ['ja', 'en'] as const) {
      const table = GUIDES[lang].slice(GUIDES[lang].search(/^## (全終了コード一覧|Exit Codes)$/m));
      expect(table).toMatch(/\| 3 \|[^\n]*NOT_IN_SESSION/);
      expect(table).toMatch(/\| 11 \|[^\n]*ask/);
      expect(table).toMatch(/\| 32 \|[^\n]*ask/);
    }
  });

  it('en: the final exit-code table has 20 / 21 / 30', () => {
    const table = GUIDES.en.slice(GUIDES.en.search(/^## Exit Codes$/m));
    expect(table).toMatch(/\| 20 \|[^\n]*VERIFY_FAILED/);
    expect(table).toMatch(/\| 21 \|[^\n]*NOT_STARTED/);
    expect(table).toMatch(/\| 30 \|[^\n]*NO_ACTIVE_SESSIONS/);
  });

  for (const lang of ['ja', 'en'] as const) {
    it(`${lang}: the ask section lists 11, 32 and the whoami/peers 3`, () => {
      const ask = sectionOf(GUIDES[lang], 'ask') as string;
      expect(ask).toMatch(/\b11\b[^\n]*(UPSTREAM_FAULT|上流)/);
      expect(ask).toContain('id=context-limit');
      expect(ask).toContain('id=model-capacity');
      expect(ask).toMatch(/\b32\b/);
      for (const name of ['whoami', 'peers']) {
        expect(sectionOf(GUIDES[lang], name) as string).toMatch(/NOT_IN_SESSION/);
      }
    });
  }
});

describe('the embedded agent guide covers the four commands (Issue #4197)', () => {
  it.each([
    '### commandmate whoami',
    '### commandmate peers',
    '### commandmate ask <worktree-id>',
    'commandmate relays resolve <relay-id> --payload',
    '--confirm',
    '--retry',
    '--discard',
    '  3   NOT_IN_SESSION',
    '  11  UPSTREAM_FAULT',
  ])('contains %s', (needle) => {
    expect(AGENT_OPERATIONS_GUIDE).toContain(needle);
  });
});
