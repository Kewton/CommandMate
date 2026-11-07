/**
 * @vitest-environment jsdom
 *
 * Issue #4218: the PC header reads "repository › branch › session", the tools
 * sit right after it, and the controls (the sessions list, "+", End, Update,
 * Info) are pushed to the right end. The sessions list holds every session —
 * the current one first, marked for sight and for assistive technology — on a
 * background of its own.
 *
 * The path under test is the real one: `DesktopHeader` (what WorktreeDetail
 * renders on PC) → identity group / `HeaderToolBar` / controls group, so the
 * order of the children and what the list holds are checked on the rendered
 * header, not on the parts alone.
 *
 * Positive / negative controls for the order check: the check is run on a
 * copy of the pre-#4218 header markup written to a temporary directory (it
 * must find the old order wrong), and on the rendered header (it must find
 * nothing).
 */

import React from 'react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { HeaderToolBar } from '@/components/worktree/HeaderToolBar';
import { AGENT_INSTANCE_DND_MIME } from '@/components/worktree/TerminalSplitPane';
import {
  CURRENT_PILL_LABEL_FIT_MIN_PX,
  LIST_SECONDARY_TEXT_CLASS,
} from '@/components/worktree/HeaderSessionSwitcher';
import { FIT_MIN_WIDTH_ATTR } from '@/hooks/useDesktopHeaderFit';
import { HEADER_TOOLS } from '@/config/activity-bar-config';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { GitStatus, Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

type InstanceStatusMap = NonNullable<Worktree['sessionStatusByInstance']>;

const running = { isRunning: true, isWaitingForResponse: false, isProcessing: true };
const waiting = { isRunning: true, isWaitingForResponse: true, isProcessing: false };

function roster(n: number): AgentInstance[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `claude-${i}`,
    cliTool: 'claude' as CLIToolType,
    alias: `Agent ${i}`,
    order: i,
  }));
}

const NAME = 'feature/4218-header';

const gitStatus = {
  currentBranch: 'hotfix/switched',
  initialBranch: NAME,
  isBranchMismatch: true,
  commitHash: 'abc1234',
  isDirty: true,
  statusUnknown: true,
} as GitStatus;

function renderFull(extra: Partial<React.ComponentProps<typeof DesktopHeader>> = {}) {
  const instances = roster(3);
  return render(
    <DesktopHeader
      worktreeName={NAME}
      repositoryName="CommandMate"
      status="running"
      onInfoClick={vi.fn()}
      gitStatus={gitStatus}
      instances={instances}
      activeInstanceId="claude-1"
      sessionStatusByInstance={
        {
          'claude-0': waiting,
          'claude-1': { ...running, awaitingInstruction: true },
        } as InstanceStatusMap
      }
      onKillSession={vi.fn()}
      activeActivity={null}
      onActivityToggle={vi.fn()}
      agentAddControl={
        <button type="button" data-testid="slot-plus">
          +
        </button>
      }
      {...extra}
    />,
  );
}

/** A child's name for the order check: its test id, or "›" for a separator. */
function childName(el: Element): string {
  if (el.hasAttribute('data-header-separator')) return '›';
  return el.getAttribute('data-testid') ?? el.tagName.toLowerCase();
}

/**
 * What is out of the #4218 order in a header's markup, as messages (empty when
 * the order is right).
 */
function headerOrderViolations(header: Element): string[] {
  const violations: string[] = [];
  const top = Array.from(header.children).map(childName);
  const expectedTop = ['desktop-header-identity', 'header-tool-bar', 'desktop-header-controls'];
  if (top.join(',') !== expectedTop.join(',')) violations.push(`header: ${top.join(',')}`);

  const identity = header.querySelector('[data-testid="desktop-header-identity"]');
  const left = identity ? Array.from(identity.children).map(childName) : [];
  const expectedLeft = [
    'desktop-status-indicator',
    'desktop-repository-name',
    '›',
    'desktop-worktree-name',
    'desktop-git-dirty',
    'desktop-git-status-unknown',
    'desktop-branch-name',
    '›',
    'desktop-agent-status-row',
  ];
  if (left.join(',') !== expectedLeft.join(',')) violations.push(`identity: ${left.join(',')}`);

  const row = header.querySelector('[data-testid="desktop-agent-status-row"]');
  const session = row ? Array.from(row.children).map((el) => (el.hasAttribute('data-session-current') ? 'pill' : childName(el))) : [];
  if (session.join(',') !== 'pill,desktop-awaiting-instruction-badge') {
    violations.push(`session: ${session.join(',')}`);
  }

  const controls = header.querySelector('[data-testid="desktop-header-controls"]');
  const right = controls ? Array.from(controls.children).map(childName) : [];
  if (right[0] !== 'desktop-session-controls' || right[right.length - 1] !== 'desktop-info-button') {
    violations.push(`controls: ${right.join(',')}`);
  }
  if (!controls?.className.split(/\s+/).includes('ml-auto')) violations.push('controls: not ml-auto');
  return violations;
}

/** The pre-#4218 header, reduced to what the order check reads. */
const PRE_4218_HEADER = `
<div data-testid="desktop-header">
  <div data-testid="desktop-header-identity">
    <span data-testid="desktop-status-indicator"></span>
    <h1 data-testid="desktop-worktree-name"></h1>
    <span data-testid="desktop-git-dirty">*</span>
    <span data-testid="desktop-git-status-unknown">?</span>
    <a data-testid="desktop-repository-name"></a>
    <span data-testid="desktop-branch-name"></span>
  </div>
  <div data-testid="desktop-header-controls" class="flex items-center gap-2 flex-shrink-0 max-w-full">
    <div data-testid="desktop-agent-status-row">
      <span data-testid="desktop-awaiting-instruction-badge"></span>
      <div data-testid="desktop-session-switcher"><button data-session-current=""></button></div>
      <button data-testid="slot-plus"></button>
    </div>
    <button data-testid="desktop-kill-session"></button>
    <button data-testid="desktop-info-button"></button>
    <div data-testid="header-tool-bar"></div>
  </div>
</div>`;

describe('[#4218] the order check (controls)', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('positive control: flags the pre-#4218 order', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4218-'));
    const file = path.join(tmp, 'header.html');
    fs.writeFileSync(file, PRE_4218_HEADER);
    const host = document.createElement('div');
    host.innerHTML = fs.readFileSync(file, 'utf-8');
    const violations = headerOrderViolations(host.firstElementChild!);
    expect(violations.length).toBeGreaterThanOrEqual(4);
    expect(violations.join('\n')).toContain('identity:');
    expect(violations.join('\n')).toContain('controls: not ml-auto');
  });

  it('negative control: the rendered header is in order', () => {
    renderFull();
    expect(headerOrderViolations(screen.getByTestId('desktop-header'))).toEqual([]);
  });
});

describe('[#4218] the header reads repository › branch › session, tools, then the controls', () => {
  it('draws the separators as decoration only', () => {
    renderFull();
    const seps = screen.getByTestId('desktop-header-identity').querySelectorAll('[data-header-separator]');
    expect(seps).toHaveLength(2);
    seps.forEach((sep) => {
      expect(sep.getAttribute('aria-hidden')).toBe('true');
      expect(sep.textContent?.trim()).toBe('›');
    });
  });

  it('has no session separator, pill or list without instances (the pre-#869 header)', () => {
    renderFull({ instances: undefined });
    const identity = screen.getByTestId('desktop-header-identity');
    expect(identity.querySelectorAll('[data-header-separator]')).toHaveLength(1);
    expect(screen.queryByTestId('desktop-agent-status-row')).toBeNull();
    expect(screen.queryByTestId('desktop-session-switcher')).toBeNull();
  });

  it('keeps Info last: nothing is drawn to its right', () => {
    renderFull();
    const controls = screen.getByTestId('desktop-header-controls');
    expect(controls.lastElementChild).toBe(screen.getByTestId('desktop-info-button'));
    expect(screen.getByTestId('desktop-header').lastElementChild).toBe(controls);
    // The "+" is the session group's last element, right after the trigger.
    const group = within(controls).getByTestId('desktop-session-controls');
    expect(group.firstElementChild).toBe(screen.getByTestId('desktop-session-switcher'));
    expect(group.lastElementChild).toBe(screen.getByTestId('slot-plus'));
  });

  it('keeps the pill clickable, draggable, titled and aria-pressed', () => {
    const onActiveInstanceChange = vi.fn();
    const onAgentDragStart = vi.fn();
    renderFull({ onActiveInstanceChange, onAgentDragStart });
    const pill = screen.getByTestId('desktop-agent-status-claude-1');
    expect(pill).toHaveAttribute('data-session-current');
    expect(screen.getByTestId('desktop-header-identity').contains(pill)).toBe(true);
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(pill.getAttribute('title')).toBe(pill.getAttribute('aria-label'));
    expect(pill.getAttribute('draggable')).toBe('true');
    fireEvent.click(pill);
    expect(onActiveInstanceChange).toHaveBeenCalledWith('claude-1');
    const data: Record<string, string> = {};
    fireEvent.dragStart(pill, {
      dataTransfer: { setData: (k: string, v: string) => (data[k] = v), effectAllowed: 'none' },
    });
    expect(data[AGENT_INSTANCE_DND_MIME]).toBe('claude-1');
    expect(onAgentDragStart).toHaveBeenCalledWith('claude-1');
  });

  it('lets the pill shrink, down to a floor, and declares the width its label keeps', () => {
    renderFull();
    const pill = screen.getByTestId('desktop-agent-status-claude-1');
    expect(pill.className).toMatch(/\bmax-w-44\b/);
    expect(pill.className).toMatch(/\bmin-w-\[4\.5rem\]/);
    expect(pill.className.split(/\s+/)).not.toContain('flex-shrink-0');
    expect(pill.className.split(/\s+/)).not.toContain('w-44');
    const label = pill.querySelector(`[${FIT_MIN_WIDTH_ATTR}]`);
    expect(label?.getAttribute(FIT_MIN_WIDTH_ATTR)).toBe(String(CURRENT_PILL_LABEL_FIT_MIN_PX));
    // The repository and the switched branch give way first, then the heading.
    expect(screen.getByTestId('desktop-repository-name').className).toMatch(/\bshrink-4\b/);
    expect(screen.getByTestId('desktop-branch-name').className).toMatch(/\bshrink-4\b/);
    expect(screen.getByTestId('desktop-worktree-name').className).toMatch(/\bshrink-2\b/);
  });
});

describe('[#4218] the sessions trigger and its list of every session', () => {
  const list = () => screen.getByTestId('desktop-session-others-list');
  const trigger = () => screen.getByTestId('desktop-agent-status-overflow');

  it('is a bordered button with an icon, in the controls group, counting every session', () => {
    renderFull();
    const t = trigger();
    expect(screen.getByTestId('desktop-header-controls').contains(t)).toBe(true);
    expect(t.className).toMatch(/\bborder\b/);
    expect(t.className).toMatch(/\bborder-border\b/);
    expect(t.className).toMatch(/\bbg-surface-2\b/);
    expect(t.querySelector('svg')).not.toBeNull();
    expect(t.textContent).toContain('Sessions 3');
    // claude-0 waits for an answer: counted, the current one would be too.
    expect(t.getAttribute('aria-label')).toBe('Sessions: 3, 1 waiting for your answer');
    expect(screen.getByTestId('desktop-session-others-waiting').textContent).toBe('1');
  });

  it('counts a waiting current session in the amber count and the living dot', () => {
    renderFull({
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: { 'claude-0': waiting } as InstanceStatusMap,
    });
    expect(screen.getByTestId('desktop-session-others-waiting').textContent).toBe('1');
    expect(trigger().querySelector('span.rounded-full')?.className).toContain('bg-warning');
  });

  it('negative control: nothing waiting → no amber count, no living dot', () => {
    renderFull({ sessionStatusByInstance: {} as InstanceStatusMap });
    expect(screen.getByTestId('desktop-session-others-waiting').textContent).toBe('');
    expect(trigger().getAttribute('aria-label')).toBe('Sessions: 3');
  });

  it('lists the current session first, marked by aria-current and a visible tag', () => {
    renderFull();
    fireEvent.click(trigger());
    const items = Array.from(list().querySelectorAll('[data-switcher-item]'));
    // Current, then the others (waiting first), then "Add session…".
    expect(items.map((el) => el.getAttribute('data-session-id') ?? el.getAttribute('data-testid'))).toEqual([
      'claude-1',
      'claude-0',
      'claude-2',
      'desktop-session-add',
    ]);
    const current = items[0];
    expect(current).toBe(screen.getByTestId('desktop-session-current-row'));
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(within(current as HTMLElement).getByTestId('desktop-session-current-tag').textContent).toBe('Showing');
    for (const other of items.slice(1)) expect(other).not.toHaveAttribute('aria-current');
    // Focus lands on the first row: the current one.
    expect(document.activeElement).toBe(current);
  });

  it('selects and drags the current row like any other', () => {
    const onActiveInstanceChange = vi.fn();
    const onAgentDragStart = vi.fn();
    renderFull({ onActiveInstanceChange, onAgentDragStart });
    fireEvent.click(trigger());
    const row = screen.getByTestId('desktop-session-current-row');
    const data: Record<string, string> = {};
    fireEvent.dragStart(row, {
      dataTransfer: { setData: (k: string, v: string) => (data[k] = v), effectAllowed: 'none' },
    });
    expect(data[AGENT_INSTANCE_DND_MIME]).toBe('claude-1');
    fireEvent.dragEnd(row);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId('desktop-session-current-row'));
    expect(onActiveInstanceChange).toHaveBeenCalledWith('claude-1');
    expect(list()).not.toBeVisible();
  });

  it('has its own tinted background, with rows, tags and separator tinted to match', () => {
    renderFull({ splitInstanceIds: ['claude-1', 'claude-0'] });
    const el = list();
    expect(el.className).toMatch(/\bbg-accent-50\b/);
    expect(el.className).toMatch(/\bdark:bg-accent-950\b/);
    expect(el.className).toMatch(/\bborder-accent-200\b/);
    expect(el.className).not.toMatch(/\bbg-surface\b/);
    const other = screen.getByTestId('desktop-agent-status-claude-0');
    expect(other.className).toMatch(/\bhover:bg-accent-200\/60\b/);
    expect(other.className).not.toMatch(/\bhover:bg-muted\b/);
    expect(screen.getByTestId('desktop-session-split-claude-0').className).toMatch(/\bbg-accent-200\b/);
    expect(el.querySelector('[role="separator"]')?.className).toMatch(/\bbg-accent-200\b/);
  });

  it('focuses the first / last row only once the list has its height cap', () => {
    // A row past the cap ("Add session…" on a short screen) must be scrolled
    // into a list that already scrolls, or it ends up below the screen.
    const caps: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      caps.push((document.querySelector('[data-testid="desktop-session-others-list"]') as HTMLElement).style.maxHeight);
    };
    try {
      renderFull();
      fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
      expect(document.activeElement).toBe(screen.getByTestId('desktop-session-add'));
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByTestId('desktop-session-current-row'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(caps.length).toBeGreaterThanOrEqual(2);
    for (const cap of caps) expect(cap).not.toBe('');
  });

  it('with one session: the trigger is drawn and the list reaches "Add session…"', () => {
    const onPlus = vi.fn();
    renderFull({
      instances: roster(1),
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: {} as InstanceStatusMap,
      agentAddControl: (
        <button type="button" data-testid="slot-plus" onClick={onPlus}>
          +
        </button>
      ),
    });
    expect(trigger().textContent).toContain('Sessions 1');
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('desktop-session-add'));
    fireEvent.click(screen.getByTestId('desktop-session-add'));
    expect(onPlus).toHaveBeenCalledTimes(1);
  });
});

describe('[#4218] the pill keeps a readable width before the header clips', () => {
  // A width model (jsdom has no layout): the identity group itself fits, but
  // the pill's label is clipped to `labelWidth`.
  let labelWidth = 120;
  let restore: Array<() => void> = [];

  beforeEach(() => {
    labelWidth = 120;
    const clientWidth = vi
      .spyOn(Element.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: Element) {
        if (this.hasAttribute(FIT_MIN_WIDTH_ATTR)) return labelWidth;
        return this.getAttribute('data-testid') === 'desktop-header-identity' ? 600 : 0;
      });
    const scrollWidth = vi
      .spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        if (this.hasAttribute(FIT_MIN_WIDTH_ATTR)) return 150;
        return this.getAttribute('data-testid') === 'desktop-header-identity' ? 600 : 0;
      });
    restore = [() => clientWidth.mockRestore(), () => scrollWidth.mockRestore()];
  });

  afterEach(() => restore.forEach((r) => r()));

  it('folds a tool when the label is clipped below its readable width', () => {
    labelWidth = CURRENT_PILL_LABEL_FIT_MIN_PX - 20;
    renderFull();
    expect(screen.getByTestId('header-tool-more')).toBeInTheDocument();
  });

  it('negative control: a label clipped above it folds nothing', () => {
    labelWidth = CURRENT_PILL_LABEL_FIT_MIN_PX + 20;
    renderFull();
    expect(screen.queryByTestId('header-tool-more')).toBeNull();
    for (const tool of HEADER_TOOLS) expect(screen.getByTestId(`header-tool-${tool.id}`)).toBeInTheDocument();
  });
});

describe('[#4218] the tools\' "…" list opens rightward from the left of the header', () => {
  it('anchors the list at the left edge of the bar', () => {
    render(<HeaderToolBar active={null} onToggle={vi.fn()} foldedCount={3} />);
    fireEvent.click(screen.getByTestId('header-tool-more'));
    const listEl = screen.getByTestId('header-tool-more-list');
    expect(listEl.className).toMatch(/\bleft-0\b/);
    expect(listEl.className).not.toMatch(/\bright-0\b/);
  });
});

/**
 * Issue #4218 (consistency review P2): the list's secondary text (status words,
 * the "Add session…" icon, the limit note) on the accent tint. Gray
 * `text-muted-foreground` fell to 3.59:1 / 2.86:1 on the dark current row and
 * its hover / focus; it now uses `LIST_SECONDARY_TEXT_CLASS`.
 */
const SECONDARY_FG = { light: 'accent-800', dark: 'accent-200' } as const;

/** What in a list's markup breaks the secondary-text rule, as messages. */
function secondaryTextViolations(listEl: Element): string[] {
  const violations: string[] = [];
  listEl.querySelectorAll('[class]').forEach((el) => {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/);
    if (cls.includes('text-muted-foreground')) violations.push(`muted: ${el.outerHTML.slice(0, 60)}`);
  });
  const secondary = Array.from(listEl.querySelectorAll('[data-session-secondary]'));
  if (secondary.length === 0) violations.push('no secondary text marked');
  for (const el of secondary) {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/);
    if (!cls.includes(`text-${SECONDARY_FG.light}`) || !cls.includes(`dark:text-${SECONDARY_FG.dark}`)) {
      violations.push(`secondary: ${el.outerHTML.slice(0, 60)}`);
    }
  }
  return violations;
}

/** The pre-fix list, reduced to what the check reads. */
const PRE_FIX_LIST = `
<div data-testid="desktop-session-others-list" class="bg-accent-50 dark:bg-accent-950">
  <button data-switcher-item="" class="bg-accent-100 dark:bg-accent-900">
    <span data-session-secondary="" class="flex-shrink-0 text-xs text-muted-foreground">Running</span>
  </button>
  <button data-switcher-item="" data-testid="desktop-session-add">
    <svg data-session-secondary="" class="h-3.5 w-3.5 text-muted-foreground"></svg>
  </button>
</div>`;

/** `--accent-NNN` RGB from globals.css, per theme block (`:root` first, `.dark` next). */
function accentScales(): Array<Record<string, number[]>> {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const scales: Array<Record<string, number[]>> = [];
  let current: Record<string, number[]> | null = null;
  for (const m of css.matchAll(/--accent-(\d+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    if (m[1] === '50' || current === null) {
      current = {};
      scales.push(current);
    }
    current[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return scales;
}

function luminance([r, g, b]: number[]): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: number[], b: number[]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const over = (top: number[], under: number[], alpha: number): number[] =>
  top.map((v, i) => v * alpha + under[i] * (1 - alpha));

describe('[#4218] the list\'s secondary text reads on its tint', () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function parsedFromTmp(markup: string): Element {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-list-fg-4218-'));
    const file = path.join(tmp, 'list.html');
    fs.writeFileSync(file, markup);
    const host = document.createElement('div');
    host.innerHTML = fs.readFileSync(file, 'utf8');
    return host.querySelector('[data-testid="desktop-session-others-list"]') as Element;
  }

  it('positive control: flags the gray secondary text of the pre-fix list', () => {
    expect(secondaryTextViolations(parsedFromTmp(PRE_FIX_LIST)).length).toBeGreaterThanOrEqual(2);
  });

  it('negative control: the rendered list (status words, add icon, limit note) passes', () => {
    renderFull({ instances: roster(10), splitInstanceIds: ['claude-1', 'claude-0'] });
    fireEvent.click(screen.getByTestId('desktop-agent-status-overflow'));
    const listEl = screen.getByTestId('desktop-session-others-list');
    expect(secondaryTextViolations(listEl)).toEqual([]);
    expect(LIST_SECONDARY_TEXT_CLASS).toBe(`text-${SECONDARY_FG.light} dark:text-${SECONDARY_FG.dark}`);
    // Status words on the current and the other rows, the "+" icon and the limit note.
    const current = screen.getByTestId('desktop-session-current-row');
    const other = screen.getByTestId('desktop-agent-status-claude-0');
    expect(current.querySelector('[data-session-secondary]')).not.toBeNull();
    expect(other.querySelector('[data-session-secondary]')).not.toBeNull();
    expect(screen.getByTestId('desktop-session-add').querySelector('[data-session-secondary]')).not.toBeNull();
    expect(screen.getByTestId('desktop-session-add-limit')).toHaveAttribute('data-session-secondary');
  });

  it('keeps 4.5:1 on every row state in both themes (globals.css values)', () => {
    const scales = accentScales();
    expect(scales.length).toBeGreaterThanOrEqual(2);
    const n = (k: string) => k.replace('accent-', '');
    for (const a of scales.slice(0, 2)) {
      // Light: list 50, other row hover/focus 200/60 over 50, current 100, its hover/focus 200.
      const light = [a['50'], over(a['200'], a['50'], 0.6), a['100'], a['200']];
      // Dark: list 950, other row hover/focus 900, current 900, its hover/focus 800.
      const dark = [a['950'], a['900'], a['900'], a['800']];
      for (const bg of light) expect(contrast(a[n(SECONDARY_FG.light)], bg)).toBeGreaterThanOrEqual(4.5);
      for (const bg of dark) expect(contrast(a[n(SECONDARY_FG.dark)], bg)).toBeGreaterThanOrEqual(4.5);
    }
    // The gray it replaced fails on the dark current row's hover (the review's 2.86:1).
    expect(contrast([156, 163, 175], scales[1]['800'])).toBeLessThan(4.5);
  });
});
