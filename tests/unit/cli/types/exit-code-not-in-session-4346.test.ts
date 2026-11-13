/**
 * Issue #4346 (1): NOT_IN_SESSION is a named member of the shared ExitCode enum.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ExitCode } from '../../../../src/cli/types';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('ExitCode.NOT_IN_SESSION (Issue #4346)', () => {
  it('is 3 — the number whoami / peers have always exited with', () => {
    expect(ExitCode.NOT_IN_SESSION).toBe(3);
  });

  it('shares the number with START_FAILED without moving any existing value', () => {
    expect(ExitCode.START_FAILED).toBe(3);
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.DEPENDENCY_ERROR).toBe(1);
    expect(ExitCode.CONFIG_ERROR).toBe(2);
    expect(ExitCode.STOP_FAILED).toBe(4);
    expect(ExitCode.UPDATE_FAILED).toBe(5);
    expect(ExitCode.UNEXPECTED_ERROR).toBe(99);
  });

  it.each(['src/cli/commands/whoami.ts', 'src/cli/commands/peers.ts'])(
    '%s exits through the enum, not a local numeric constant',
    (file) => {
      const src = read(file);
      expect(src).toMatch(/process\.exit\(ExitCode\.NOT_IN_SESSION\)/);
      expect(src).not.toMatch(/NOT_IN_SESSION\s*=\s*3/);
    }
  );

  it.each(['docs/user-guide/cli-operations-guide.md', 'docs/en/user-guide/cli-operations-guide.md'])(
    '%s lists exit 3 as NOT_IN_SESSION',
    (file) => {
      expect(read(file)).toMatch(/\| 3 \|[^\n]*NOT_IN_SESSION/);
    }
  );
});
