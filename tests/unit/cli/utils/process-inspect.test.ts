/**
 * Issue #3087: process inspection used by stop/start.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { createServer } from 'net';
import {
  describeProcess,
  findListeningPids,
  isExitedState,
  parseProcStat,
} from '../../../../src/cli/utils/process-inspect';

describe('parseProcStat', () => {
  it('reads state and pgrp after the last parenthesis, even when comm contains ") ("', () => {
    expect(parseProcStat('665 (node) (x) Z 1 665 665 0 -1 4194564')).toEqual({ state: 'Z', pgrp: 665 });
    expect(parseProcStat('875 (node) S 1 862 862 0 -1')).toEqual({ state: 'S', pgrp: 862 });
  });

  it('returns null for content it cannot parse', () => {
    expect(parseProcStat('12345')).toBeNull();
    expect(parseProcStat('1 (x)')).toBeNull();
  });
});

describe('isExitedState', () => {
  it('counts zombie and dead as exited, everything else as running', () => {
    expect(isExitedState('Z')).toBe(true);
    expect(isExitedState('X')).toBe(true);
    expect(isExitedState('S')).toBe(false);
    expect(isExitedState('R')).toBe(false);
  });
});

describe('findListeningPids', () => {
  it('finds this process listening on a loopback port', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      expect(findListeningPids(port)).toContain(process.pid);
      expect(describeProcess(process.pid)).toEqual(expect.any(String));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('finds nothing on a port nobody listens on', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise((resolve) => server.close(resolve));

    expect(findListeningPids(port)).toEqual([]);
  });
});
