/**
 * opencode live command registry — parser, provider, palette shaping (Issue #2036)
 *
 * The fixtures below are the real bodies `GET /command` answered on opencode
 * 1.18.22 in the isolated harness (docs/design/opencode-server-live-verification.md
 * §12), trimmed of the `template` field for length. Everything asserted here was
 * observed before it was written down.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MAX_OPENCODE_COMMANDS,
  fetchOpencodeCommands,
  fetchOpencodeLiveCommands,
  isUsableOpencodePort,
  isValidOpencodeLiveName,
  opencodeCommandUrl,
  parseOpencodeCommandDocument,
} from '@/lib/slash-command-reconcile/providers/opencode';
import { opencodeLiveCommandsToSlashCommands } from '@/lib/slash-commands';
import { foldInMissingCommands } from '@/lib/command-merger';
import type { SlashCommandGroup } from '@/types/slash-commands';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

/** What 1.18.22 answered in a project carrying `.opencode/commands/test.md`. */
const LIVE_BODY = [
  { name: 'init', description: 'guided AGENTS.md setup', source: 'command', hints: ['$ARGUMENTS'] },
  {
    name: 'review',
    description: 'review changes [commit|branch|pr], defaults to uncommitted',
    source: 'command',
    subtask: true,
    hints: ['$ARGUMENTS'],
  },
  {
    name: 'test',
    description: 'Issue 2036 probe custom command',
    source: 'command',
    agent: 'build',
    hints: ['$ARGUMENTS'],
  },
  {
    name: 'customize-opencode',
    description: "Use ONLY when the user is editing or creating opencode's own configuration",
    source: 'skill',
    hints: [],
  },
  {
    name: 'probe-agents-root',
    description: 'CommandMate probe skill planted at .agents/skills',
    source: 'skill',
    hints: [],
  },
];

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: { get: () => init.contentType ?? 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

describe('parseOpencodeCommandDocument (Issue #2036)', () => {
  it('reads the fields the palette needs off a real 1.18.22 body', () => {
    const parsed = parseOpencodeCommandDocument(LIVE_BODY);

    expect(parsed.map((c) => c.name)).toEqual([
      'init',
      'review',
      'test',
      'customize-opencode',
      'probe-agents-root',
    ]);

    const test = parsed.find((c) => c.name === 'test');
    expect(test?.description).toBe('Issue 2036 probe custom command');
    expect(test?.source).toBe('command');
    expect(test?.hints).toEqual(['$ARGUMENTS']);
    expect(test?.agent).toBe('build');

    // Measured: a Skill is listed here with source 'skill' even though the
    // opencode palette never offers it. The two axes must stay distinguishable.
    expect(parsed.find((c) => c.name === 'probe-agents-root')?.source).toBe('skill');
    expect(parsed.find((c) => c.name === 'review')?.subtask).toBe(true);
    expect(parsed.find((c) => c.name === 'init')?.subtask).toBe(false);
  });

  it('is total: any shape at all answers a list', () => {
    for (const body of [null, undefined, 42, 'nope', {}, { commands: [] }]) {
      expect(parseOpencodeCommandDocument(body)).toEqual([]);
    }
  });

  it('drops a row whose name could be read as a path or a key separator', () => {
    const parsed = parseOpencodeCommandDocument([
      { name: '../../etc/passwd', source: 'command' },
      { name: 'a..b', source: 'command' },
      { name: 'has space', source: 'command' },
      { name: '/leading-slash', source: 'command' },
      { name: '', source: 'command' },
      { name: 42, source: 'command' },
      { name: 'ok-name', source: 'command' },
    ]);
    expect(parsed.map((c) => c.name)).toEqual(['ok-name']);
  });

  it('keeps the first of a repeated name and caps the list', () => {
    const parsed = parseOpencodeCommandDocument([
      { name: 'dup', description: 'first', source: 'command' },
      { name: 'dup', description: 'second', source: 'command' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].description).toBe('first');

    const flood = Array.from({ length: MAX_OPENCODE_COMMANDS + 50 }, (_, i) => ({
      name: `cmd-${i}`,
      source: 'command',
    }));
    expect(parseOpencodeCommandDocument(flood)).toHaveLength(MAX_OPENCODE_COMMANDS);
  });

  it('strips control characters out of a description', () => {
    const parsed = parseOpencodeCommandDocument([
      { name: 'noisy', description: 'a\u0000b\u001bc\nd', source: 'command' },
    ]);
    expect(parsed[0].description).toBe('a b c d');
  });

  it('accepts the name shapes a real skills directory produces', () => {
    expect(isValidOpencodeLiveName('catalog-reconcile')).toBe(true);
    expect(isValidOpencodeLiveName('Demo_Video')).toBe(true);
    expect(isValidOpencodeLiveName('v1.2')).toBe(true);
    expect(isValidOpencodeLiveName('..')).toBe(false);
    expect(isValidOpencodeLiveName('-leading-dash')).toBe(false);
  });
});

describe('fetchOpencodeLiveCommands (Issue #2036)', () => {
  it('targets loopback and nothing else', () => {
    expect(opencodeCommandUrl(4903)).toBe('http://127.0.0.1:4903/command');
    expect(isUsableOpencodePort(4903)).toBe(true);
    for (const bad of [0, -1, 65536, 1.5, '4903', null, undefined]) {
      expect(isUsableOpencodePort(bad), String(bad)).toBe(false);
    }
  });

  it('refuses to follow a redirect', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(LIVE_BODY));
    await fetchOpencodeLiveCommands({ port: 4903, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4903/command',
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('answers ok:false rather than throwing on every failure shape', async () => {
    const cases: Array<[string, typeof fetch]> = [
      ['dead port', (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch],
      ['http error', (async () => jsonResponse([], { status: 503 })) as unknown as typeof fetch],
      ['squatter serving html', (async () =>
        jsonResponse('<html>', { contentType: 'text/html' })) as unknown as typeof fetch],
      ['object instead of array', (async () => jsonResponse({ commands: [] })) as unknown as typeof fetch],
    ];
    for (const [label, fetchImpl] of cases) {
      const result = await fetchOpencodeLiveCommands({ port: 4903, fetchImpl });
      expect(result.ok, label).toBe(false);
    }

    expect((await fetchOpencodeLiveCommands({ port: 0 })).ok).toBe(false);
  });
});

describe('fetchOpencodeCommands as a reconcile provider (Issue #2036)', () => {
  it('is skipped without a port, because the port cannot be guessed', async () => {
    const result = await fetchOpencodeCommands();
    expect(result.tool).toBe('opencode');
    expect(result.ok).toBe(false);
    expect(result.commands).toEqual([]);
  });

  it('offers only source:"command" rows to the catalog, never a Skill', async () => {
    const fetchImpl = (async () => jsonResponse(LIVE_BODY)) as unknown as typeof fetch;
    const result = await fetchOpencodeCommands({ port: 4903, fetchImpl });

    expect(result.ok).toBe(true);
    // A Skill is a per-project file. Letting one in would ship one developer's
    // .agents/skills directory to every user — the #1503 phantom shape.
    expect(result.commands.map((c) => c.name)).toEqual(['init', 'review', 'test']);
    expect(result.commands.find((c) => c.name === 'init')?.description).toBe(
      'guided AGENTS.md setup'
    );
  });

  it('warns that the TUI built-ins are not in this document', async () => {
    const fetchImpl = (async () => jsonResponse(LIVE_BODY)) as unknown as typeof fetch;
    const result = await fetchOpencodeCommands({ port: 4903, fetchImpl });
    // Measured on 1.18.22: /agents … /variants are compiled into the terminal UI
    // and the server has never heard of them, so this source cannot replace the
    // palette reading the attestation records for them.
    expect(result.warnings.join(' ')).toContain('TUI built-ins');
    for (const builtin of ['agents', 'themes', 'variants', 'status']) {
      expect(result.commands.some((c) => c.name === builtin), builtin).toBe(false);
    }
  });

  it('never stamps a version: the document carries none', async () => {
    const fetchImpl = (async () => jsonResponse(LIVE_BODY)) as unknown as typeof fetch;
    const result = await fetchOpencodeCommands({ port: 4903, fetchImpl });
    expect(result.sourceVersion).toBeUndefined();
  });
});

describe('opencodeLiveCommandsToSlashCommands (Issue #2036)', () => {
  const palette = opencodeLiveCommandsToSlashCommands(parseOpencodeCommandDocument(LIVE_BODY));

  it('gives the project custom command its frontmatter description', () => {
    const test = palette.find((c) => c.name === 'test');
    expect(test).toBeDefined();
    expect(test?.description).toContain('Issue 2036 probe custom command');
    expect(test?.cliTools).toEqual(['opencode']);
    expect(test?.source).toBe('worktree');
    expect(test?.category).toBe('workflow');
  });

  it('carries the argument hint, which SlashCommand has no field for', () => {
    expect(palette.find((c) => c.name === 'test')?.description).toBe(
      'Issue 2036 probe custom command · $ARGUMENTS'
    );
    // A Skill declares no hints, so nothing is appended and no separator dangles.
    expect(palette.find((c) => c.name === 'probe-agents-root')?.description).toBe(
      'CommandMate probe skill planted at .agents/skills'
    );
  });

  it('files a Skill under the skill category with the skill source', () => {
    const skill = palette.find((c) => c.name === 'probe-agents-root');
    expect(skill?.category).toBe('skill');
    expect(skill?.source).toBe('skill');
    // Not 'codex-skill': getSlashCommandTrigger spells that as `$name`, and the
    // route measured to work on opencode is `/name` (§12.5).
    expect(skill?.source).not.toBe('codex-skill');
  });

  it('never carries a descriptionKey — this text has nothing to translate to', () => {
    for (const command of palette) {
      expect(command.descriptionKey).toBeUndefined();
    }
  });
});

describe('foldInMissingCommands (Issue #2036)', () => {
  const catalogGroups: SlashCommandGroup[] = [
    {
      category: 'standard-session',
      label: 'Session',
      commands: [
        {
          name: 'init',
          descriptionKey: 'slashCommands.descriptions.init.opencode',
          category: 'standard-session',
          cliTools: ['opencode'],
          filePath: '',
          source: 'standard',
        },
      ],
    },
  ];

  it('adds the names the catalog cannot know about', () => {
    const folded = foldInMissingCommands(
      catalogGroups,
      opencodeLiveCommandsToSlashCommands(parseOpencodeCommandDocument(LIVE_BODY))
    );
    const names = folded.flatMap((g) => g.commands.map((c) => c.name));
    expect(names).toContain('test');
    expect(names).toContain('probe-agents-root');
  });

  it('never replaces a catalog entry, so a translated description survives', () => {
    const folded = foldInMissingCommands(
      catalogGroups,
      opencodeLiveCommandsToSlashCommands(parseOpencodeCommandDocument(LIVE_BODY))
    );
    const init = folded.flatMap((g) => g.commands).filter((c) => c.name === 'init');
    expect(init).toHaveLength(1);
    // The live row would have brought literal English here; the catalog's key
    // is what renders 説明 in ja. Overriding it is the regression this guards.
    expect(init[0].descriptionKey).toBe('slashCommands.descriptions.init.opencode');
    expect(init[0].description).toBeUndefined();
  });

  it('returns the same object when there is nothing to add', () => {
    expect(foldInMissingCommands(catalogGroups, [])).toBe(catalogGroups);
    const sameKey = [
      {
        name: 'init',
        description: 'live text',
        category: 'workflow' as const,
        cliTools: ['opencode' as const],
        filePath: '',
      },
    ];
    expect(foldInMissingCommands(catalogGroups, sameKey)).toBe(catalogGroups);
  });

  it('treats a different CLI tool scope as a different command', () => {
    const claudeScoped = [
      {
        name: 'init',
        description: 'a claude entry that happens to share the name',
        category: 'workflow' as const,
        filePath: '',
      },
    ];
    const folded = foldInMissingCommands(catalogGroups, claudeScoped);
    expect(folded.flatMap((g) => g.commands).filter((c) => c.name === 'init')).toHaveLength(2);
  });
});
