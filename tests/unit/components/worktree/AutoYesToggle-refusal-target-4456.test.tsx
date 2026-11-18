/**
 * Issue #4456 re-instruction 1 (I4'): a refusal notice belongs to the target the
 * refused request was for (worktree, instance) and to the generation of the
 * shown state the request started in. A change of either hides it, and an
 * answer arriving after such a change is not shown. A new refusal for the same
 * target is always shown.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import { ToolPolicyRefusalError } from '@/lib/tool-policy/refusal-view';

const view = {
  message: 'Refused by default for antigravity (4456 target).',
  links: { terms: 'https://antigravity.google/terms', faq: 'https://antigravity.google/docs/faq' },
};
const NOTICE = 'auto-yes-tool-policy-refusal';

function enable(): void {
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));
}

type Props = Partial<React.ComponentProps<typeof AutoYesToggle>>;

function toggle(onToggle: (p: AutoYesToggleParams) => Promise<void>, props: Props = {}) {
  return (
    <AutoYesToggle
      enabled={false}
      expiresAt={null}
      onToggle={onToggle}
      cliToolName="antigravity"
      worktreeId="wt-1"
      instanceId="antigravity"
      {...props}
    />
  );
}

describe("AutoYesToggle: a refusal is tied to its target and state generation (I4', 4456)", () => {
  it('switched to another instance of the same tool after the refusal: not shown (4456)', async () => {
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockRejectedValue(new ToolPolicyRefusalError(view));
    const { rerender } = render(toggle(onToggle));
    enable();
    await screen.findByTestId(NOTICE);
    rerender(toggle(onToggle, { instanceId: 'antigravity-2' }));
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('another worktree with the same instance id: not shown (4456)', async () => {
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockRejectedValue(new ToolPolicyRefusalError(view));
    const { rerender } = render(toggle(onToggle));
    enable();
    await screen.findByTestId(NOTICE);
    rerender(toggle(onToggle, { worktreeId: 'wt-2' }));
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('the answer held while the instance is switched, then a 409: not shown on the new instance (4456)', async () => {
    let reject: (err: unknown) => void = () => {};
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>(
      () => new Promise<void>((_resolve, rej) => { reject = rej; }),
    );
    const { rerender } = render(toggle(onToggle));
    enable();
    rerender(toggle(onToggle, { instanceId: 'claude', cliToolName: 'claude' }));
    await act(async () => {
      reject(new ToolPolicyRefusalError(view));
    });
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('the answer held while the state went ON and OFF elsewhere: not shown (4456)', async () => {
    let reject: (err: unknown) => void = () => {};
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>(
      () => new Promise<void>((_resolve, rej) => { reject = rej; }),
    );
    const { rerender } = render(toggle(onToggle));
    enable();
    rerender(toggle(onToggle, { enabled: true, expiresAt: Date.now() + 3_600_000 }));
    rerender(toggle(onToggle));
    await act(async () => {
      reject(new ToolPolicyRefusalError(view));
    });
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('re-enabled right after a local expiry and refused: the next poll (enabled=false) does not drop it (4456)', async () => {
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockRejectedValue(new ToolPolicyRefusalError(view));
    // Armed, but the countdown already ran out: shown OFF before the poll catches up (#959).
    const { rerender } = render(toggle(onToggle, { enabled: true, expiresAt: Date.now() - 1000 }));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    enable();
    await screen.findByTestId(NOTICE);
    rerender(toggle(onToggle));
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
  });

  it('a new refusal for the same target is shown, also after visiting another instance (4456)', async () => {
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockRejectedValue(new ToolPolicyRefusalError(view));
    const { rerender } = render(toggle(onToggle));
    enable();
    await screen.findByTestId(NOTICE);
    rerender(toggle(onToggle, { instanceId: 'antigravity-2' }));
    rerender(toggle(onToggle));
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    enable();
    expect((await screen.findByTestId(`${NOTICE}-message`)).textContent).toBe(view.message);
  });

  it('a held answer for the same, unchanged target is shown (4456)', async () => {
    let reject: (err: unknown) => void = () => {};
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>(
      () => new Promise<void>((_resolve, rej) => { reject = rej; }),
    );
    const { rerender } = render(toggle(onToggle));
    enable();
    rerender(toggle(onToggle));
    await act(async () => {
      reject(new ToolPolicyRefusalError(view));
    });
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
  });
});
