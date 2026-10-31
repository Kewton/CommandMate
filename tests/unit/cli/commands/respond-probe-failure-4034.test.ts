/**
 * Issue #4034 (item 2): `respond` when the capability probe itself fails.
 *
 * `serverReportsPromptAnswerReason` answers false when the probe cannot be
 * completed (401 / 403 / the network), which keeps the pre-#3982 reading of the
 * reason code out of the 500's text. #3982's tests cover a 200 without the word
 * and a real 404 only; this fixes the throwing probe.
 *
 * Positive controls: a 500 whose text carries `answer_input_lost` is shown as
 * InputLost although the probe threw. Negative controls: without the code in
 * the text it is the general error.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { resetServerCapabilityProbe } from '../../../../src/cli/utils/server-capabilities';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  resetServerCapabilityProbe();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function stderr(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

type Probe = 'unauthorized' | 'forbidden' | 'network';

/** A server whose `/api/capabilities` fails as `probe` says and whose answer is `answer`. */
function mockServer(probe: Probe, error: string): void {
  global.fetch = vi.fn((input: unknown) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (path.startsWith('/api/capabilities')) {
      if (probe === 'network') return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(jsonResponse({ error: 'denied' }, probe === 'unauthorized' ? 401 : 403));
    }
    if (path.includes('/current-output')) return Promise.resolve(jsonResponse({}));
    return Promise.resolve(jsonResponse({ error }, 500));
  }) as unknown as typeof fetch;
}

async function respond(args: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', ...args]);
}

const LOST = 'Failed to send answer to tmux: send-keys failed for "answer_input_lost"';
const OTHER = 'Failed to send answer to tmux: no such session';

describe('[#4034] respond: the capability probe throws, the text is read as before #3982', () => {
  for (const probe of ['unauthorized', 'forbidden', 'network'] as const) {
    it(`positive (${probe}): answer_input_lost in the 500 text is shown as InputLost`, async () => {
      mockServer(probe, LOST);
      await respond(['wt1', '1', '--agent', 'claude']);

      expect(stderr()).toContain('partly typed (reason: answer_input_lost)');
      expect(mockExit).toHaveBeenCalledWith(99);
    });

    it(`negative (${probe}): without the code in the text it is the general error`, async () => {
      mockServer(probe, OTHER);
      await respond(['wt1', '1', '--agent', 'claude']);

      expect(stderr()).not.toContain('partly typed');
      expect(stderr()).toContain('no such session');
      expect(mockExit).toHaveBeenCalledWith(99);
    });
  }
});
