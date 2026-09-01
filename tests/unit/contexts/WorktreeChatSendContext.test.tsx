/**
 * WorktreeChatSendContext (Issue #2213).
 *
 * The seam that lets the phone's docked composer reach the optimistic send held
 * by the chat surface inside the terminal tab. What matters here is not that a
 * value can be stored — it is the four rules the wiring depends on:
 *
 *  1. a registered send reaches a composer aimed at the SAME agent;
 *  2. a composer aimed at a different agent gets `undefined`, so a registration
 *     left over from the previous instance for one render cannot put a bubble in
 *     a transcript that is no longer the one being sent to;
 *  3. unmounting the surface releases the slot — this is what puts the composer
 *     back on its await-then-clear path when the phone switches back to the
 *     terminal (which unmounts the surface, and with it `useSplitMessages`);
 *  4. with no provider at all, every hook degrades to "no registration", which is
 *     what keeps PC — whose split wires `onOptimisticSend` directly and never
 *     renders this provider — untouched.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  WorktreeChatSendProvider,
  useChatComposerInsert,
  useChatOptimisticSend,
  useRegisterChatOptimisticSend,
  type ChatOptimisticSendFn,
  type ChatSendTarget,
} from '@/contexts/WorktreeChatSendContext';
import type { CLIToolType } from '@/lib/cli-tools/types';

function Surface({
  cliToolId,
  instanceId,
  send,
}: {
  cliToolId: CLIToolType;
  instanceId?: string;
  send: ChatOptimisticSendFn;
}) {
  useRegisterChatOptimisticSend({ cliToolId, instanceId, send });
  return <div data-testid="surface" />;
}

function Composer({ target }: { target: ChatSendTarget }) {
  const optimisticSend = useChatOptimisticSend(target);
  return (
    <button
      type="button"
      data-testid="composer"
      data-has-send={optimisticSend ? 'yes' : 'no'}
      onClick={() => optimisticSend?.('hello', { cliToolId: target.cliToolId })}
    />
  );
}

function DiscardButton({ content }: { content: string }) {
  const insert = useChatComposerInsert();
  return (
    <button type="button" data-testid="discard" onClick={() => insert(content)} />
  );
}

describe('[#2213] WorktreeChatSendContext', () => {
  let send: ChatOptimisticSendFn;

  beforeEach(() => {
    send = vi.fn();
  });

  it('hands the registered send to a composer aimed at the same agent', () => {
    render(
      <WorktreeChatSendProvider>
        <Surface cliToolId="claude" send={send} />
        <Composer target={{ cliToolId: 'claude' }} />
      </WorktreeChatSendProvider>,
    );

    expect(screen.getByTestId('composer')).toHaveAttribute('data-has-send', 'yes');

    act(() => {
      screen.getByTestId('composer').click();
    });
    expect(send).toHaveBeenCalledWith('hello', { cliToolId: 'claude' });
  });

  it('treats an omitted instanceId as the primary instance on both sides', () => {
    render(
      <WorktreeChatSendProvider>
        <Surface cliToolId="claude" instanceId="claude" send={send} />
        <Composer target={{ cliToolId: 'claude' }} />
      </WorktreeChatSendProvider>,
    );

    expect(screen.getByTestId('composer')).toHaveAttribute('data-has-send', 'yes');
  });

  it('withholds the send when the composer targets a different instance', () => {
    render(
      <WorktreeChatSendProvider>
        <Surface cliToolId="claude" instanceId="claude-2" send={send} />
        <Composer target={{ cliToolId: 'claude', instanceId: 'claude-3' }} />
      </WorktreeChatSendProvider>,
    );

    expect(screen.getByTestId('composer')).toHaveAttribute('data-has-send', 'no');
  });

  it('withholds the send when the composer targets a different CLI tool', () => {
    render(
      <WorktreeChatSendProvider>
        <Surface cliToolId="claude" send={send} />
        <Composer target={{ cliToolId: 'codex' }} />
      </WorktreeChatSendProvider>,
    );

    expect(screen.getByTestId('composer')).toHaveAttribute('data-has-send', 'no');
  });

  it('releases the slot when the surface unmounts', () => {
    function Screen({ chatVisible }: { chatVisible: boolean }) {
      return (
        <WorktreeChatSendProvider>
          {chatVisible && <Surface cliToolId="claude" send={send} />}
          <Composer target={{ cliToolId: 'claude' }} />
        </WorktreeChatSendProvider>
      );
    }

    const { rerender } = render(<Screen chatVisible />);
    expect(screen.getByTestId('composer')).toHaveAttribute('data-has-send', 'yes');

    rerender(<Screen chatVisible={false} />);
    expect(screen.getByTestId('composer')).toHaveAttribute('data-has-send', 'no');
  });

  it('re-points the slot at the new surface when the target changes', () => {
    const other = vi.fn();
    function Screen({ instanceId }: { instanceId: string }) {
      return (
        <WorktreeChatSendProvider>
          <Surface
            cliToolId="claude"
            instanceId={instanceId}
            send={instanceId === 'claude-2' ? send : other}
          />
          <Composer target={{ cliToolId: 'claude', instanceId }} />
        </WorktreeChatSendProvider>
      );
    }

    const { rerender } = render(<Screen instanceId="claude-2" />);
    act(() => {
      screen.getByTestId('composer').click();
    });
    expect(send).toHaveBeenCalledTimes(1);

    rerender(<Screen instanceId="claude-3" />);
    act(() => {
      screen.getByTestId('composer').click();
    });
    expect(other).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('routes a discarded draft back to the screen composer', () => {
    const onInsertToComposer = vi.fn();
    render(
      <WorktreeChatSendProvider onInsertToComposer={onInsertToComposer}>
        <DiscardButton content="half typed" />
      </WorktreeChatSendProvider>,
    );

    act(() => {
      screen.getByTestId('discard').click();
    });
    expect(onInsertToComposer).toHaveBeenCalledWith('half typed');
  });

  it('is inert without a provider (PC renders none)', () => {
    render(
      <>
        <Surface cliToolId="claude" send={send} />
        <Composer target={{ cliToolId: 'claude' }} />
        <DiscardButton content="x" />
      </>,
    );

    expect(screen.getByTestId('composer')).toHaveAttribute('data-has-send', 'no');
    expect(() => {
      act(() => {
        screen.getByTestId('discard').click();
      });
    }).not.toThrow();
  });
});
