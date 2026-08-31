/**
 * The `ask` policy's other half: what the human actually sees (Issue #2068).
 *
 * Under `CM_CODEX_UPDATE_DIALOG=ask`, `CodexTool.waitForReady` answers nothing
 * and leaves codex's update dialog on the pane. That is only half a feature —
 * the pane has to reach a human who can answer it. This file closes the loop
 * from the OTHER end of the pipeline: the real captured frame goes through the
 * real `detectPrompt`, and the resulting `promptData` is handed to the real
 * `PromptPanel`, which must offer all three of codex's own options and post the
 * digit the operator picked.
 *
 * Nothing about the panel changed for this Issue, and that is the point worth
 * asserting: the `ask` policy works because the update dialog was already a
 * three-option `multiple_choice` prompt, and the only thing standing between it
 * and the operator was `waitForReady` answering first.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

import { PromptPanel } from '@/components/worktree/PromptPanel';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions } from '@/lib/detection/cli-patterns';
import type { PanelPromptData } from '@/components/worktree/PromptPanel';

const UPDATE_DIALOG = fs.readFileSync(
  path.join(process.cwd(), 'tests/fixtures/codex-update-dialog-2068/update-dialog-01491.txt'),
  'utf-8'
);

/** The live frame, through the real detector — no hand-built prompt data. */
function codexUpdatePromptData(): PanelPromptData {
  const detection = detectPrompt(UPDATE_DIALOG, buildDetectPromptOptions('codex'));
  expect(detection.promptData).not.toBeNull();
  return detection.promptData as PanelPromptData;
}

function renderPanel(onRespond = vi.fn().mockResolvedValue(undefined)) {
  render(
    <PromptPanel
      promptData={codexUpdatePromptData()}
      messageId="msg-2068"
      visible
      answering={false}
      onRespond={onRespond}
      cliToolName="Codex CLI"
    />
  );
  return onRespond;
}

/** The radio for one of codex's option numbers. */
function option(number: '1' | '2' | '3'): HTMLInputElement {
  const radio = screen
    .getAllByRole('radio')
    .find((el): el is HTMLInputElement => (el as HTMLInputElement).value === number);
  expect(radio).toBeDefined();
  return radio as HTMLInputElement;
}

async function submitAndRead(onRespond: ReturnType<typeof vi.fn>): Promise<string> {
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => {
    expect(onRespond).toHaveBeenCalled();
  });
  return onRespond.mock.calls[0][0] as string;
}

describe('[#2068] PromptPanel offers codex’s update dialog to the human', () => {
  it('draws all three options, labelled with codex’s own wording', () => {
    renderPanel();

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['1', '2', '3']);
    expect(option('1').closest('label')?.textContent).toContain('Update now');
    expect(option('2').closest('label')?.textContent).toContain('Skip');
    expect(option('3').closest('label')?.textContent).toContain('Skip until next version');
  });

  it('shows codex’s question, so the operator knows which versions are in play', () => {
    renderPanel();
    expect(screen.getByText(/0\.149\.1 -> 0\.151\.0/)).toBeInTheDocument();
  });

  it('lets the operator choose "3", which is the one that persists', async () => {
    const onRespond = renderPanel();

    fireEvent.click(option('3'));

    expect(await submitAndRead(onRespond)).toBe('3');
  });

  it('lets the operator choose "1" — the choice CommandMate never makes for them', async () => {
    const onRespond = renderPanel();

    fireEvent.click(option('1'));

    expect(await submitAndRead(onRespond)).toBe('1');
  });
});
