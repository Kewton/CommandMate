/**
 * Tests for OpencodeSidebarNotice (Issue #2095).
 *
 * Three properties this file holds:
 *
 *  1. **It appears on the frame `ctrl+x b` produced and not on the one before
 *     it.** Driven by the real fixtures Issue #2046 captured from a live
 *     opencode 1.18.22 — the same session one keystroke apart — through the real
 *     detector, so this is the acceptance condition rather than a mock of it.
 *  2. **It offers no button.** #2046 took `b` out of the published chord letters
 *     and the special-keys route refuses it. A notice that shipped a button
 *     would be re-opening that decision by the back door, so the absence is
 *     asserted, not left to review.
 *  3. **It is opencode-only.** The same bytes under a different tool render
 *     nothing, which is the acceptance condition "no other tool changes" stated
 *     where this surface could break it.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  OpencodeSidebarNotice,
  hasOpenCodeSidebarObstruction,
} from '@/components/worktree/OpencodeSidebarNotice';
import { OPENCODE_SIDEBAR_RECOVERY_CHORD } from '@/lib/detection/opencode-pane-obstruction';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/opencode-live-2046/w80');
const frame = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf-8');

describe('OpencodeSidebarNotice (Issue #2095)', () => {
  it('renders on the frame `ctrl+x b` produced, naming the key that closes it', () => {
    render(<OpencodeSidebarNotice cliToolId="opencode" frame={frame('sidebar-on')} />);

    expect(screen.getByTestId('opencode-sidebar-notice')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-sidebar-notice-chord')).toHaveTextContent('ctrl+x b');
    expect(screen.getByTestId('opencode-sidebar-notice-chord')).toHaveTextContent(
      OPENCODE_SIDEBAR_RECOVERY_CHORD,
    );
  });

  it('renders nothing on the same session one keystroke earlier', () => {
    const { container } = render(
      <OpencodeSidebarNotice cliToolId="opencode" frame={frame('sidebar-off')} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('offers no button — the chord it names cannot be sent from here', () => {
    // #2046: `b` is absent from OPENCODE_LEADER_CHORD_VALUES and the
    // special-keys route 400s on it. The user has to press it in the pane, and
    // a control here would be a promise this surface cannot keep.
    render(<OpencodeSidebarNotice cliToolId="opencode" frame={frame('sidebar-on')} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it.each(['claude', 'codex', 'copilot', 'gemini'] as const)(
    'renders nothing for %s on the identical bytes',
    (cliToolId) => {
      const { container } = render(
        <OpencodeSidebarNotice cliToolId={cliToolId} frame={frame('sidebar-on')} />,
      );

      expect(container).toBeEmptyDOMElement();
    },
  );

  it('survives a frame that has not arrived yet', () => {
    // A pane that rendered nothing because the snippet was one tick late would
    // be a far worse failure than a notice that appears one tick late.
    expect(hasOpenCodeSidebarObstruction('opencode', undefined)).toBe(false);
    expect(hasOpenCodeSidebarObstruction('opencode', null)).toBe(false);
    expect(hasOpenCodeSidebarObstruction('opencode', '')).toBe(false);
  });

  it('shares one predicate with the surfaces that gate on it', () => {
    // PC (`TerminalSplitPaneContent`) and phone (`MobileTerminalTab`) both call
    // this, for the reason `hasUnsentComposerText` exists: a condition copied to
    // two call sites is how the two screens come to disagree about one session.
    expect(hasOpenCodeSidebarObstruction('opencode', frame('sidebar-on'))).toBe(true);
    expect(hasOpenCodeSidebarObstruction('opencode', frame('sidebar-off'))).toBe(false);
    expect(hasOpenCodeSidebarObstruction('claude', frame('sidebar-on'))).toBe(false);
  });
});
