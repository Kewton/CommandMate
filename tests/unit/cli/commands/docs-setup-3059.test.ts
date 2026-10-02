/**
 * `commandmate docs --section setup` (Issue #3059).
 *
 * The landing page hands an agent one sentence that points at
 * https://kewton.github.io/CommandMate/setup.md. `website/` is not in the npm
 * package, so the CLI carries the same guide as a string constant. What is
 * pinned here is that the two are the same bytes — an agent that read the page
 * and one that ran `docs --section setup` must be told the same thing — and
 * that the guide keeps the shape the Issue asks for: five stages, each with the
 * same five headings, and the operations a person must approve named up front.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SETUP_GUIDE } from '../../../../src/cli/docs/setup-guide';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SETUP_MD = path.join(REPO_ROOT, 'website', 'setup.md');
const LLMS_TXT = path.join(REPO_ROOT, 'website', 'llms.txt');

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function stdout(): string {
  return mockConsoleLog.mock.calls.flat().join('\n');
}

/** The guide split into its `## Stage N:` sections, in order. */
function stages(): { title: string; body: string }[] {
  const parts = SETUP_GUIDE.split(/^## (?=Stage \d+:)/m).slice(1);
  return parts.map((part) => {
    const [title, ...rest] = part.split('\n');
    // A stage ends where the next `## ` section begins.
    const body = rest.join('\n').split(/^## /m)[0];
    return { title, body };
  });
}

describe('the setup guide is one text in two places', () => {
  it('embeds website/setup.md byte for byte', () => {
    expect(fs.readFileSync(SETUP_MD, 'utf-8')).toBe(SETUP_GUIDE);
  });

  it('is linked from website/llms.txt at its Pages URL', () => {
    expect(fs.readFileSync(LLMS_TXT, 'utf-8')).toContain(
      '](https://kewton.github.io/CommandMate/setup.md)',
    );
  });
});

describe('docs --section setup', () => {
  it('prints the setup guide', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--section', 'setup']);

    // `toContain`, not `toBe`: process.exit is mocked to a no-op, so the action
    // falls through to its help footer after printing the section.
    expect(stdout()).toContain(SETUP_GUIDE);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('is listed by --all, alongside the other sections', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--all']);

    const out = stdout();
    expect(out).toContain('- setup');
    expect(out).toContain('- delegation');
    expect(out).toContain('- quick-start');
  });

  it('is searchable, like every other section', async () => {
    const { createDocsCommand } = await import('../../../../src/cli/commands/docs');
    await createDocsCommand().parseAsync(['node', 'docs', '--search', 'Pair your phone']);

    expect(stdout()).toContain('--- setup ---');
  });
});

describe('the setup guide has the shape the Issue asks for', () => {
  it('opens with instructions for the agent reading it', () => {
    const intro = SETUP_GUIDE.split(/^## Stage 1:/m)[0];

    expect(intro).toContain('## Instructions for the agent reading this');
    expect(intro).toMatch(/Explain each stage before you start it/);
    expect(intro).toMatch(/Never run an "Ask the person first" step without a clear yes/);
    expect(intro).toMatch(/Check the machine; do not assume it/);
  });

  it('has the five stages, in order', () => {
    expect(stages().map((stage) => stage.title)).toEqual([
      'Stage 1: Install and start',
      'Stage 2: Pair your phone',
      'Stage 3: Add a second agent',
      'Stage 4: Give your team a PM',
      "Stage 5: Let checks decide what's done",
    ]);
  });

  it('gives every stage the same five headings, in order', () => {
    const headings = ['Check', 'Run', 'Ask the person first', 'Confirm it worked', 'If it fails'];

    for (const { title, body } of stages()) {
      const found = Array.from(body.matchAll(/^### (.+)$/gm), ([, heading]) => heading);
      expect(found, title).toEqual(headings);
    }
  });

  it('names every operation a person must approve, before the first stage', () => {
    const intro = SETUP_GUIDE.split(/^## Stage 1:/m)[0];
    const always = intro.split('### Always ask the person first')[1];

    expect(always).toBeDefined();
    expect(always).toMatch(/Installing anything/);
    expect(always).toContain('`commandmate remote`');
    expect(always).toContain('`CM_BIND=0.0.0.0`');
    expect(always).toMatch(/Auto Yes/);
    expect(always).toMatch(/Merging a pull request/);
  });

  it('leaves the provider to the person, and --yes to their consent', () => {
    const pair = stages()[1].body;

    expect(pair).toContain('--provider tailscale');
    expect(pair).toContain('--provider cloudflare --yes');
    expect(pair).toMatch(/the person chooses which one/);
    expect(pair).toMatch(/Never add `--yes` to get past a question they have not answered/);
  });

  it('links only to this project and to official package distributors', () => {
    const allowed = [
      'https://github.com/Kewton/CommandMate',
      'https://kewton.github.io/CommandMate/',
      'https://nodejs.org/',
      'http://localhost:',
    ];
    const urls = Array.from(SETUP_GUIDE.matchAll(/https?:\/\/[^\s)`]+/g), ([url]) => url);

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !allowed.some((prefix) => url.startsWith(prefix)))).toEqual([]);
  });
});
