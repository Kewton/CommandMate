/**
 * `commandmate docs --section team-setup` (Issue #4464).
 *
 * The README hands an agent one block that points at
 * https://kewton.github.io/CommandMate/team-setup.md. `website/` is not in the
 * npm package, so the CLI carries the same guide as a string constant, the way
 * `setup` does (docs-setup-3059). Pinned here:
 *
 * - I2: the page and `docs --section team-setup` are the same bytes.
 * - I1: every `commandmate …` the guide writes resolves to a registered command
 *   and its flags, and every `exit N` it names is a code the CLI defines.
 * - I3: the operations a person approves are named up front, and approving a
 *   mem decision is the person's, on the screen.
 * - I4: no AI-driven role goes to Antigravity, with the terms named.
 * - I5: no banned term or unmeasured claim from docs/design/public-messaging.md,
 *   and the lead is claimed only where it was measured.
 * - The guide carries nothing that only works in this repository.
 *
 * Each check is a function, also applied to a weakened copy (in memory, or in a
 * directory under os.tmpdir()), so a vacuous pass shows.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TEAM_SETUP_GUIDE } from '../../../../src/cli/docs/team-setup-guide';
import { SETUP_GUIDE } from '../../../../src/cli/docs/setup-guide';
import { buildProgram } from '../../../../src/cli/program';
import { createAskCommand } from '../../../../src/cli/commands/ask';
import { createWhoamiCommand } from '../../../../src/cli/commands/whoami';
import { createPeersCommand } from '../../../../src/cli/commands/peers';
import { createRelaysCommand } from '../../../../src/cli/commands/relays';
import { createRolesCommand } from '../../../../src/cli/commands/roles';
import * as cliTypes from '../../../../src/cli/types';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TEAM_SETUP_MD = path.join(REPO_ROOT, 'website', 'team-setup.md');
const README = path.join(REPO_ROOT, 'README.md');
const MESSAGING_DOC = path.join(REPO_ROOT, 'docs/design/public-messaging.md');
const TEAM_SETUP_URL = 'https://kewton.github.io/CommandMate/team-setup.md';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const tmpDirs: string[] = [];

afterEach(() => {
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function stdout(): string {
  return mockConsoleLog.mock.calls.flat().join('\n');
}

/** A scratch copy of `text` under os.tmpdir(), removed in afterEach. */
function tmpCopy(name: string, text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-setup-4464-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

/** I2: does the file hold exactly the embedded guide? */
function sameAsEmbedded(file: string, embedded: string): boolean {
  return fs.readFileSync(file, 'utf-8') === embedded;
}

/**
 * The guide with the `#` that starts a line inside a fenced code block replaced
 * by `_` (same length, so offsets still match the guide): a heading inside a
 * template is not a heading of the guide.
 */
function withoutFences(guide: string): string {
  return guide.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, (block) => block.replace(/^#/gm, '_'));
}

/** The guide split into its `## Phase N:` sections, in order (code blocks kept, their headings ignored). */
function phases(guide: string): { title: string; body: string }[] {
  const shape = withoutFences(guide);
  const starts = Array.from(shape.matchAll(/^## /gm), (m) => m.index!);
  return starts
    .map((start, i) => ({ start, end: starts[i + 1] ?? guide.length }))
    .filter(({ start }) => shape.startsWith('## Phase ', start))
    .map(({ start, end }) => {
      const [title, ...rest] = guide.slice(start + 3, end).split('\n');
      return { title, body: rest.join('\n') };
    });
}

/** The `### ` headings of a phase body, outside code blocks. */
function headingsOf(body: string): string[] {
  return Array.from(withoutFences(body).matchAll(/^### (.+)$/gm), ([, heading]) => heading);
}

// ---------------------------------------------------------------------------
// I1: commands, flags and exit codes exist
// ---------------------------------------------------------------------------

/** The whole CLI as `src/cli/index.ts` assembles it. */
function fullProgram(): Command {
  const program = buildProgram();
  program.addCommand(createAskCommand());
  program.addCommand(createWhoamiCommand());
  program.addCommand(createPeersCommand());
  program.addCommand(createRelaysCommand());
  program.addCommand(createRolesCommand());
  return program;
}

/**
 * Every `commandmate …` invocation the guide writes: lines of fenced code
 * blocks, and inline code spans that start with `commandmate `.
 */
function commandLines(guide: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of guide.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const trimmed = line.trim();
      if (trimmed.startsWith('commandmate ')) lines.push(trimmed);
      continue;
    }
    for (const [, span] of line.matchAll(/`(commandmate [^`]+)`/g)) lines.push(span);
  }
  return lines;
}

/** Shell-ish split: quotes kept together, comments, heredocs and pipes cut off. */
function tokens(line: string): string[] {
  const cut = line.split(/\s+#\s|\s<<|\s\|\s|\s&&\s|;\s/)[0];
  return Array.from(cut.matchAll(/"[^"]*"|'[^']*'|\S+/g), ([t]) => t);
}

function hasOption(command: Command, flag: string): boolean {
  if (flag === '--help' || flag === '-h') return true;
  return command.options.some((option) => option.long === flag || option.short === flag);
}

/** What in one invocation the registered CLI does not know. */
function unknownParts(program: Command, line: string): string[] {
  const words = tokens(line).slice(1); // drop `commandmate`
  const problems: string[] = [];
  let command: Command = program;

  const first = words[0];
  if (first === undefined || first.startsWith('<')) return problems; // `commandmate <command> --help`
  if (!first.startsWith('-')) {
    const found = program.commands.find((c) => c.name() === first || c.aliases().includes(first));
    if (!found) return [`command "${first}"`];
    command = found;
    words.shift();
  }

  for (const word of words) {
    if (word.startsWith('-')) {
      const flag = word.split('=')[0];
      if (!hasOption(command, flag)) problems.push(`${command.name()} ${flag}`);
      continue;
    }
    const sub = command.commands.find((c) => c.name() === word);
    if (sub) command = sub;
  }
  return problems;
}

function unknownCommandParts(guide: string): string[] {
  const program = fullProgram();
  return commandLines(guide).flatMap((line) => unknownParts(program, line).map((p) => `${p}  ←  ${line}`));
}

/** Every exit code value src/cli/types defines (ExitCode and the *ExitCode tables). */
function definedExitCodes(): Set<number> {
  const codes = new Set<number>();
  for (const [name, value] of Object.entries(cliTypes)) {
    if (!/ExitCode$/.test(name) || typeof value !== 'object' || value === null) continue;
    for (const code of Object.values(value)) if (typeof code === 'number') codes.add(code);
  }
  return codes;
}

function undefinedExitCodes(guide: string): number[] {
  const known = definedExitCodes();
  const said = Array.from(guide.matchAll(/\bexits? \**(\d+)\**/g), ([, n]) => Number(n));
  return [...new Set(said)].filter((n) => !known.has(n));
}

// ---------------------------------------------------------------------------
// I3 / I4 / I5 and the repository-only check
// ---------------------------------------------------------------------------

function approvalProblems(guide: string): string[] {
  const intro = guide.split(/^## Phase 1:/m)[0];
  const always = intro.split('### Always ask the person first')[1] ?? '';
  const problems: string[] = [];
  const required: [string, RegExp][] = [
    ['install', /Installing anything/],
    ['git change', /Changing files in their repository or its Git state/],
    ['instance', /Creating or changing an instance or a role/],
    ['permission', /Changing a permission/],
    ['auto yes', /Turning on Auto Yes/],
    ['merge', /Merging a pull request/],
    ['decision on screen', /Approving a mem decision is never yours\.[^\n]*only when a person approves it on CommandMate's screen/],
    ['no CLI approval', /The CLI has no way to approve it/],
  ];
  for (const [name, pattern] of required) if (!pattern.test(always)) problems.push(name);
  // No path for an agent to approve: the guide never names an approve/promote command.
  if (/commandmate mem (promote|approve)|commandmate handoff (approve|confirm)|--approve\b/.test(guide)) {
    problems.push('an approval command');
  }
  return problems;
}

function antigravityProblems(guide: string): string[] {
  const problems: string[] = [];
  const section = guide.split('### Antigravity (agy)')[1]?.split(/^## /m)[0] ?? '';
  if (!section) return ['no Antigravity section'];
  if (!section.includes('https://antigravity.google/terms')) problems.push('terms link');
  if (!section.includes('https://antigravity.google/docs/faq')) problems.push('faq link');
  if (!/Section 6/.test(section)) problems.push('Section 6');
  if (!/No AI agent sends, asks, responds or relays to agy/.test(section)) problems.push('no send');
  if (!/Never turn on Auto Yes for agy/.test(section)) problems.push('no auto yes');
  if (!/never given a role that an AI agent drives/.test(section)) problems.push('no AI role');
  // No command targets it, and the team table gives it no role.
  for (const line of commandLines(guide)) {
    if (/--(agent|instance)\s+(antigravity|agy)\b/.test(line)) problems.push(`command: ${line}`);
  }
  const table = guide.split('| The person has |')[1]?.split('\n\n')[0] ?? '';
  if (!table) problems.push('no team table');
  if (/antigravity|\bagy\b/i.test(table)) problems.push('Antigravity in the team table');
  return problems;
}

/** The banned names (§8) and the scannable unmeasured claims (§5) of the messaging doc. */
function messagingBans(): string[] {
  const doc = fs.readFileSync(MESSAGING_DOC, 'utf-8');
  const banned = doc.slice(doc.indexOf('<!-- banned-terms:start -->'), doc.indexOf('<!-- banned-terms:end -->'));
  const terms = Array.from(banned.matchAll(/^\|\s*`([^`]+)`\s*\|/gm), ([, t]) => t);
  const section5 = doc.slice(doc.indexOf('## 5.'), doc.indexOf('## 6.'));
  const claims = Array.from(section5.matchAll(/^\|\s*`([^`]+)`\s*\|/gm), ([, t]) => t).filter(
    (claim) => claim !== 'loop' && !claim.startsWith('the only'),
  );
  // §6's own "書かない表現" table only (its first table lists routes, not wording).
  const section6 = doc.slice(doc.indexOf('## 6.'), doc.indexOf('## 7.'));
  const retracted = section6.slice(section6.lastIndexOf('### '));
  const network = Array.from(retracted.matchAll(/^\|\s*`([^`]+)`/gm), ([, t]) => t);
  return [...terms, ...claims, ...network];
}

function messagingProblems(text: string): string[] {
  const lower = text.toLowerCase();
  const problems = messagingBans().filter((term) => lower.includes(term.toLowerCase()));
  if (/\bthe only\b/i.test(text)) problems.push('the only');
  if (/\bloop\b/i.test(text)) problems.push('loop');
  return problems;
}

/** The lead is claimed only on the two CLIs it was measured on (public-messaging §5). */
function leadClaimProblems(guide: string): string[] {
  const problems: string[] = [];
  if (!/PM and development lead have been tried in recorded runs on Claude Code and on Command Code/.test(guide)) {
    problems.push('measured lead statement');
  }
  if (!/led from Codex alone has not been/.test(guide)) problems.push('Codex lead not measured');
  const table = (guide.split('| The person has |')[1] ?? '').split('\n\n')[0];
  const rows = table.split('\n').filter((l) => l.startsWith('|'));
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    // cells: '', has, PM, lead, worker, reviewer, judge, ''
    const [pm, lead] = [cells[2], cells[3]];
    if (pm === undefined || pm.startsWith('---')) continue;
    for (const cell of [pm, lead]) {
      if (!['Claude Code', 'Command Code'].includes(cell)) problems.push(`lead or PM on ${cell}`);
    }
  }
  return problems;
}

/** Things that only work in this repository's own development setup. */
function repositoryOnlyProblems(guide: string): string[] {
  const needles = ['claude3-reserve', 'commandmatedev', 'workspace/orchestration', 'runs/', 'mycodebranchdesk', '/orchestrate'];
  return needles.filter((needle) => guide.toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('[#4464 I2] the team setup guide is one text in two places', () => {
  it('embeds website/team-setup.md byte for byte', () => {
    expect(sameAsEmbedded(TEAM_SETUP_MD, TEAM_SETUP_GUIDE)).toBe(true);
  });

  it('control: a copy that differs by one byte is caught', () => {
    expect(sameAsEmbedded(tmpCopy('team-setup.md', TEAM_SETUP_GUIDE), TEAM_SETUP_GUIDE)).toBe(true);
    expect(sameAsEmbedded(tmpCopy('team-setup.md', `${TEAM_SETUP_GUIDE} `), TEAM_SETUP_GUIDE)).toBe(false);
  });

  it('is a guide of its own, not the setup guide', () => {
    expect(TEAM_SETUP_GUIDE).not.toBe(SETUP_GUIDE);
  });
});

describe('[#4464] docs --section team-setup', () => {
  it('prints the team setup guide', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--section', 'team-setup']);

    // process.exit is a no-op here, so the action falls through to its help footer.
    expect(stdout()).toContain(TEAM_SETUP_GUIDE);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('is listed by --all, next to setup and the reader\'s sections', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--all']);

    const out = stdout();
    expect(out).toContain('- team-setup');
    expect(out).toContain('- setup');
    expect(out).toContain('- delegation');
    expect(out).toContain('- quick-start');
  });

  it('is searchable, like every other section', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--search', 'Five fixed roles']);

    expect(stdout()).toContain('--- team-setup ---');
  });

  it('still prints the setup guide for --section setup (unchanged)', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--section', 'setup']);

    expect(stdout()).toContain(SETUP_GUIDE);
    expect(stdout()).not.toContain(TEAM_SETUP_GUIDE);
  });
});

describe('[#4464] the guide has the shape the Issue asks for', () => {
  it('opens with instructions for the agent reading it', () => {
    const intro = TEAM_SETUP_GUIDE.split(/^## Phase 1:/m)[0];

    expect(intro).toContain('## Instructions for the agent reading this');
    expect(intro).toMatch(/Explain each phase before you start it/);
    expect(intro).toMatch(/Never run an "Ask the person first" step without a clear yes/);
    expect(intro).toMatch(/Check the machine; do not assume it/);
    expect(intro).toContain('commandmate docs --section team-setup');
  });

  it('has the five phases, in order', () => {
    expect(phases(TEAM_SETUP_GUIDE).map((phase) => phase.title)).toEqual([
      'Phase 1: Environment, your agent CLIs and a team that fits them',
      'Phase 2: Five fixed roles and isolated worktrees',
      'Phase 3: Done means the checks passed',
      'Phase 4: mem, the restart brief, screen-only approval, and the instructions file',
      'Phase 5: The first GitHub Milestone',
    ]);
  });

  it('gives every phase the same five headings as the setup guide, in order', () => {
    const headings = ['Check', 'Run', 'Ask the person first', 'Confirm it worked', 'If it fails'];

    for (const { title, body } of phases(TEAM_SETUP_GUIDE)) {
      expect(headingsOf(body), title).toEqual(headings);
    }
  });

  it('starts from a machine without CommandMate, and from a single vendor', () => {
    const phase1 = phases(TEAM_SETUP_GUIDE)[0].body;

    expect(phase1).toContain('npm install -g commandmate');
    expect(phase1).toMatch(/^\| Claude Code only \|/m);
    expect(phase1).toMatch(/^\| Command Code only \|/m);
  });

  it('fixes the roles with --role and names exit 32', () => {
    const phase2 = phases(TEAM_SETUP_GUIDE)[1].body;

    for (const role of ['pm', 'dev-lead', 'worker', 'reviewer', 'judge']) {
      expect(phase2).toContain(`commandmate roles add ${role} --stdin`);
    }
    expect(phase2).toContain('--role pm');
    expect(phase2).toMatch(/exits \*\*32\*\*/);
    expect(phase2).toMatch(/not a permission/);
  });

  it('lets the checks decide: verify.yaml, a contract, wait --verify with 0 / 20 / 21', () => {
    const phase3 = phases(TEAM_SETUP_GUIDE)[2].body;

    expect(phase3).toContain('commandmate verify init --cwd <repository-path> --dry-run');
    expect(phase3).toContain('requireScopeClean: true');
    expect(phase3).toContain('/.claude/skills/cmate-*/');
    expect(phase3).toMatch(/`wait --verify` exits \*\*0\*\* when every gate passed, \*\*20\*\* when a gate failed, and \*\*21\*\*/);
    expect(cliTypes.VerifyExitCode).toMatchObject({ SUCCESS: 0, VERIFY_FAILED: 20, NOT_STARTED: 21 });
  });

  it('turns mem on on the screen, briefs on restart, and keeps promote for the person', () => {
    const phase4 = phases(TEAM_SETUP_GUIDE)[3].body;

    expect(phase4).toMatch(/only be changed on CommandMate's screen/);
    expect(phase4).toContain('commandmate brief');
    expect(phase4).toContain('--promote-to issue:#<n>');
    expect(phase4).toMatch(/Only the person approves it, on CommandMate's screen/);
    expect(phase4).toContain('--dry-run');
  });

  it('runs the first milestone until one issue passes the checks', () => {
    const phase5 = phases(TEAM_SETUP_GUIDE)[4].body;

    expect(phase5).toContain('gh issue list --milestone');
    expect(phase5).toMatch(/--verify` exited 0/);
    expect(phase5).toMatch(/You never approve or merge on the person's behalf/);
  });

  it('links only to this project, official distributors and the Antigravity terms', () => {
    const allowed = [
      'https://github.com/Kewton/CommandMate',
      'https://github.com/Kewton/commandmate-team-demo',
      'https://kewton.github.io/CommandMate/',
      'https://nodejs.org/',
      'https://antigravity.google/terms',
      'https://antigravity.google/docs/faq',
    ];
    const urls = Array.from(TEAM_SETUP_GUIDE.matchAll(/https?:\/\/[^\s)`]+/g), ([url]) => url);

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !allowed.some((prefix) => url.startsWith(prefix)))).toEqual([]);
  });
});

describe('[#4464 I1] every command, flag and exit code in the guide exists', () => {
  it('finds the commands it checks', () => {
    // Enough of them that an empty extraction cannot pass the next test.
    expect(commandLines(TEAM_SETUP_GUIDE).length).toBeGreaterThan(40);
  });

  it('every `commandmate …` resolves to a registered command and its flags', () => {
    expect(unknownCommandParts(TEAM_SETUP_GUIDE)).toEqual([]);
  });

  it('control: an unknown command, subcommand flag or flag is caught', () => {
    const weakened = [
      '```bash',
      'commandmate roles add pm --stdin',
      'commandmate teams add pm',
      'commandmate roles add pm --role pm',
      'commandmate send <id> "hi" --instance claude --as pm',
      '```',
      'and inline `commandmate mem promote --approve`',
    ].join('\n');

    expect(unknownCommandParts(weakened).map((p) => p.split('  ←  ')[0])).toEqual([
      'command "teams"',
      'add --role',
      'send --as',
      'mem --approve',
    ]);
  });

  it('every exit code it names is one the CLI defines', () => {
    expect(undefinedExitCodes(TEAM_SETUP_GUIDE)).toEqual([]);
    expect(undefinedExitCodes('wait exits 77, verify exits **20**')).toEqual([77]);
  });

  it('names exit 32 and 33 for what the CLI means by them', () => {
    expect(cliTypes.RoleExitCode.NOT_SENT).toBe(32);
    expect(cliTypes.ToolPolicyExitCode.DENIED).toBe(33);
    expect(TEAM_SETUP_GUIDE).toMatch(/Exit 32 from `send --role`/);
    expect(TEAM_SETUP_GUIDE).toMatch(/refuses a send to agy from an agent with exit 33/);
  });
});

describe('[#4464 I3] the person approves, and mem decisions are approved on the screen only', () => {
  it('names every operation a person must approve, before the first phase', () => {
    expect(approvalProblems(TEAM_SETUP_GUIDE)).toEqual([]);
  });

  it('control: a guide without the screen-only rule, or with an approve command, fails', () => {
    const noScreen = TEAM_SETUP_GUIDE.replace('**Approving a mem decision is never yours.**', '');
    const withApprove = `${TEAM_SETUP_GUIDE}\n\`commandmate mem promote <id>\`\n`;

    expect(approvalProblems(noScreen)).toContain('decision on screen');
    expect(approvalProblems(withApprove)).toContain('an approval command');
  });
});

describe('[#4464 I4] Antigravity is never driven by an AI agent', () => {
  it('states the rule with the terms, and gives agy no role', () => {
    expect(antigravityProblems(TEAM_SETUP_GUIDE)).toEqual([]);
  });

  it('control: a team table row or a command that drives agy fails', () => {
    const inTable = TEAM_SETUP_GUIDE.replace(
      '| Claude Code only |',
      '| Antigravity only | Antigravity | Antigravity | Antigravity | Antigravity | Antigravity |\n| Claude Code only |',
    );
    const command = `${TEAM_SETUP_GUIDE}\n\`commandmate send <id> "hi" --instance antigravity\`\n`;

    expect(antigravityProblems(inTable)).toContain('Antigravity in the team table');
    expect(antigravityProblems(command).some((p) => p.startsWith('command:'))).toBe(true);
  });
});

describe('[#4464 I5] public messaging: no banned words, no claim past what was measured', () => {
  it('the guide and the README carry no banned term or unmeasured claim', () => {
    expect(messagingBans().length).toBeGreaterThan(5);
    expect(messagingProblems(TEAM_SETUP_GUIDE)).toEqual([]);
    expect(messagingProblems(fs.readFileSync(README, 'utf-8'))).toEqual([]);
  });

  it('claims the PM and lead only on Claude Code and Command Code', () => {
    expect(leadClaimProblems(TEAM_SETUP_GUIDE)).toEqual([]);
  });

  it('control: a banned word or a Codex-led row fails', () => {
    expect(messagingProblems('runs 24/7 with no supervision')).toEqual(['runs 24/7', 'no supervision']);
    const codexLed = TEAM_SETUP_GUIDE.replace(
      '| Claude Code only |',
      '| Codex only | Codex | Codex | Codex | Codex | Codex |\n| Claude Code only |',
    );
    expect(leadClaimProblems(codexLed)).toEqual(['lead or PM on Codex', 'lead or PM on Codex']);
  });
});

describe('[#4464] nothing that only works in this repository', () => {
  it('has no in-house script, dev CLI or run file', () => {
    expect(repositoryOnlyProblems(TEAM_SETUP_GUIDE)).toEqual([]);
    expect(repositoryOnlyProblems('npx tsx scripts/agent-health/claude3-reserve.ts reserve')).toEqual(['claude3-reserve']);
  });
});

describe('[#4464] README: the one block to paste, near the top', () => {
  const readme = (): string => fs.readFileSync(README, 'utf-8');

  it('offers a copyable prompt pointing at team-setup.md, before "The problem"', () => {
    const text = readme();
    const prompt = /```text\n(Read https:\/\/kewton\.github\.io\/CommandMate\/team-setup\.md [^\n]+)\n```/.exec(text);

    expect(prompt).not.toBeNull();
    expect(text.indexOf(prompt![0])).toBeLessThan(text.indexOf('## The problem'));
    expect(prompt![1]).toMatch(/ask me before/);
    expect(text).toContain(TEAM_SETUP_URL);
  });

  it('keeps the setup prompt and the approval sentence other tests pin', () => {
    const text = readme();

    expect(text).toContain('Read https://kewton.github.io/CommandMate/setup.md and help me set up CommandMate on this machine.');
    expect(text).toContain('Every step that changes something waits for your approval');
    expect(text).toContain('Most people need only Level 2.');
  });
});
