/**
 * The ja/en guides say an uncertain relay delivery is not resent automatically (Issue #4064).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('relay uncertain delivery in the CLI operations guide (Issue #4064)', () => {
  it('ja: states that an uncertain delivery is not resent and where the hold is read', () => {
    const guide = read('docs/user-guide/cli-operations-guide.md');
    expect(guide).toContain('#### 不確定な配送は自動で再送しない（Issue #4064）');
    expect(guide).toContain('**自動で再送しません**');
    expect(guide).toContain('`commandmate capture <worktree-id> --instance <instance> --pane`');
    expect(guide).toContain('`delivery=uncertain`');
  });

  it('en: the same', () => {
    const guide = read('docs/en/user-guide/cli-operations-guide.md');
    expect(guide).toContain('#### An uncertain delivery is never resent automatically (Issue #4064)');
    expect(guide).toContain('does **not resend that payload automatically**');
    expect(guide).toContain('`commandmate capture <worktree-id> --instance <instance> --pane`');
    expect(guide).toContain('`delivery=uncertain`');
  });
});
