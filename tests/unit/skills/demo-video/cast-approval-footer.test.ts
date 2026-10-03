/**
 * Approval frames in the claude cassettes must read as a real dialog (Issue #3081).
 *
 * The footer of a live approval is `Esc to cancel · Tab to amend · ctrl+e to explain`;
 * the input-box hint line made `/prompt-response` refuse with `prompt_no_longer_active`.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { evaluateDialogPresence } from '@/lib/polling/auto-yes-dialog-gate';

const FIXTURES = path.resolve(__dirname, '../../../../.claude/skills/demo-video/fixtures');
const CASSETTES = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.cast'));

function approvalFrames(file: string): string[] {
  return fs
    .readFileSync(path.join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((line) => line.includes('Do you want to proceed?'))
    .filter((line) => line.includes('\\e[2J'))
    .map((line) => line.slice(line.indexOf('\t') + 1).replace(/\\e/g, '\x1b').replace(/\\n/g, '\n'));
}

describe('demo-video cassettes: approval frame footer', () => {
  it('has claude cassettes with approval frames', () => {
    expect(CASSETTES.flatMap(approvalFrames).length).toBeGreaterThan(0);
  });

  for (const file of CASSETTES) {
    for (const [i, frame] of approvalFrames(file).entries()) {
      it(`${file} frame #${i}: live footer, no input-hint line`, () => {
        expect(frame).toContain('Esc to cancel · Tab to amend · ctrl+e to explain');
        expect(frame).not.toContain('manual mode on');
      });

      it(`${file} frame #${i}: evaluateDialogPresence('claude') is present`, () => {
        const verdict = evaluateDialogPresence('claude', 'multiple_choice', frame);
        expect(verdict.present).toBe(true);
      });
    }
  }
});
