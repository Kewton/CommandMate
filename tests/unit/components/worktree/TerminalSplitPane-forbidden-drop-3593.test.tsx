/**
 * @vitest-environment jsdom
 *
 * Issue #3593: a session another split shows can be dragged onto a split and
 * is refused there with a toast. A real browser fires no `drop` once
 * `dragover` set `dropEffect` to 'none', so the pane used to swallow the
 * forbidden drop before the container could refuse it (the e2e in
 * `tests/e2e/header-session-switcher-3593.spec.ts` shows it with a real
 * mouse). The pane now keeps `dropEffect` 'move' and says "not here" with its
 * red ring; the container's rules decide.
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitPane, AGENT_INSTANCE_DND_MIME } from '@/components/worktree/TerminalSplitPane';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

function renderPane(draggedInstanceId: string, onDropInstance = vi.fn()) {
  render(
    <TerminalSplitPane
      worktreeId="w-3593"
      splitIndex={1}
      cliToolId="codex"
      instanceId="codex"
      instance={inst('codex')}
      // claude is in split 1, so it is not available here.
      availableInstances={[inst('codex'), inst('gemini')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      terminal={<div />}
      footer={<div />}
      onDropInstance={onDropInstance}
      draggedInstanceId={draggedInstanceId}
    />,
  );
  return { region: screen.getByRole('region', { name: /Terminal split 2/i }), onDropInstance };
}

function dataTransfer(payload: string) {
  return {
    dropEffect: 'none',
    effectAllowed: 'move',
    types: [AGENT_INSTANCE_DND_MIME],
    getData: (type: string) => (type === AGENT_INSTANCE_DND_MIME ? payload : ''),
    setData: vi.fn(),
  };
}

describe('[#3593] a forbidden drag still reaches the drop', () => {
  it('keeps dropEffect "move" for a session another split shows, with the red ring', () => {
    const { region } = renderPane('claude');
    const dt = dataTransfer('claude');
    fireEvent.dragOver(region, { dataTransfer: dt });
    expect(dt.dropEffect).toBe('move');
    expect(region.className).toMatch(/ring-red-300/);
  });

  it('hands the forbidden drop to the container, which refuses it', () => {
    const { region, onDropInstance } = renderPane('claude');
    fireEvent.drop(region, { dataTransfer: dataTransfer('claude') });
    expect(onDropInstance).toHaveBeenCalledWith('claude');
  });

  it('negative control: an allowed drag is "move" with the accent ring, as before', () => {
    const { region } = renderPane('gemini');
    const dt = dataTransfer('gemini');
    fireEvent.dragOver(region, { dataTransfer: dt });
    expect(dt.dropEffect).toBe('move');
    expect(region.className).toMatch(/ring-accent-400/);
  });
});
