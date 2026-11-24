/**
 * Issue #4535 (T16 の画面, design `send-outcome-4535.md` 第 2.1 版 §3.4・C10・C12): what the screen's
 * `isSendOutcomeUnknown` keeps reading as "not sent" (a direct retry is safe).
 *
 * - 401 `AUTH_REQUIRED` / 403 `IP_DENIED` (C12, the middleware's answers before the route) → not unknown
 * - a 4xx that says `sendOutcome: 'not_sent'` → not unknown
 * - a 409 that says `sendOutcome: 'unknown'` (the fence, #4534) → unknown
 * - a 4xx with no `sendOutcome` (a proxy's or tunnel's page, C10) → unknown
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { isSendOutcomeUnknown } from '@/hooks/usePendingMessages';
import { ApiError } from '@/lib/api-client';

describe('[#4535 T16] isSendOutcomeUnknown and the typed refusals before the route', () => {
  it('control: 401 AUTH_REQUIRED is not unknown', () => {
    expect(isSendOutcomeUnknown(new ApiError('Unauthorized', 401, { error: 'Unauthorized', code: 'AUTH_REQUIRED' }))).toBe(false);
  });

  it.each([
    ['403 IP_DENIED', new ApiError('Forbidden', 403, { error: 'Forbidden', code: 'IP_DENIED' })],
    ['400 not_sent', new ApiError('model refused', 400, { error: 'model refused', code: 'model_refused', sendOutcome: 'not_sent' })],
    ['404 not_sent', new ApiError('Worktree not found', 404, { error: 'Worktree not found', sendOutcome: 'not_sent' })],
    ['409 SEND_TARGET_CHANGED not_sent', new ApiError('x', 409, { error: 'x', code: 'SEND_TARGET_CHANGED', sendOutcome: 'not_sent' })],
  ])('control: %s is not unknown', (_name, error) => {
    expect(isSendOutcomeUnknown(error)).toBe(false);
  });

  it('a proxy 4xx without sendOutcome is unknown', () => {
    expect(isSendOutcomeUnknown(new ApiError('Bad Request', 400, {}))).toBe(true);
    expect(isSendOutcomeUnknown(new ApiError('Unauthorized', 401, { error: 'Unauthorized' }))).toBe(true);
    expect(isSendOutcomeUnknown(new ApiError('HTTP error 413', 413, {}))).toBe(true);
  });

  it('a 409 SEND_TARGET_CHANGED unknown is unknown', () => {
    expect(isSendOutcomeUnknown(new ApiError('x', 409, { error: 'x', code: 'SEND_TARGET_CHANGED', sendOutcome: 'unknown' }))).toBe(true);
  });
});
