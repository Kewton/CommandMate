/**
 * Keep the whole frame a `screen-*` check judged (Issue #3183).
 *
 * The report carries `paneEvidence` — the ANSI-stripped, blank-compacted,
 * truncated tail of the pane — which is enough to read but not enough to
 * reproduce: a detector rule reads SGR attributes, box-drawing rows and the
 * pane's full height, and every fixture README in `tests/fixtures/` asks for
 * the raw `capture-pane -p -e` bytes. So a failing screen used to mean a second
 * live capture before anyone could write the fixture.
 *
 * Now the frame is written as captured, byte for byte, next to the report:
 *
 * ```
 * <dir of reports>/../frames/<date>/<tool>-<checkId>[-<screen>].txt   the capture
 * <dir of reports>/../frames/<date>/<tool>-<checkId>[-<screen>].json  what it was judged as
 * ```
 *
 * (`~/.commandmate/agent-health/frames/<date>/` by default.) Only failing
 * checks are kept unless {@link SAVE_FRAMES_ENV_VAR} is `all`, which is how a
 * whole day's live frames are collected on purpose (design doc §6 item 2).
 *
 * Writing a frame never fails the run: the report is the product, and a frame
 * that could not be written leaves the check without `framePaths`, nothing more.
 *
 * @module lib/agent-health/frame-archive
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AgentHealthCheck, AgentHealthTool } from './types';

/** `all` keeps every `screen-*` frame; anything else keeps only failing ones. */
export const SAVE_FRAMES_ENV_VAR = 'CM_AGENT_HEALTH_SAVE_FRAMES';

export type FrameSaveMode = 'fail' | 'all';

/** Where frames go for one run, and which ones. */
export interface FrameArchive {
  /** `<…>/frames/<date>` — created on the first write. */
  readonly dir: string;
  readonly mode: FrameSaveMode;
}

/** One frame a check judged. `screen` names the picker for `screen-picker` (`/model`). */
export interface JudgedFrame {
  readonly frame: string;
  readonly screen?: string;
}

/** What is written beside the frame, so the `.txt` stays the capture and nothing else. */
export interface FrameMeta {
  tool: AgentHealthTool;
  checkId: AgentHealthCheck['checkId'];
  screen?: string;
  status: AgentHealthCheck['status'];
  summary: string;
  version: string | null;
  savedAt: string;
}

export function resolveFrameSaveMode(env: Readonly<Record<string, string | undefined>> = process.env): FrameSaveMode {
  return env[SAVE_FRAMES_ENV_VAR]?.trim() === 'all' ? 'all' : 'fail';
}

/**
 * The frames directory for a report written to `reportPath`: a `frames`
 * directory beside the report's own directory, one sub-directory per date.
 */
export function framesDirFor(reportPath: string, date: string): string {
  return path.join(path.dirname(path.dirname(path.resolve(reportPath))), 'frames', date);
}

/** `<tool>-<checkId>[-<screen>]`, with the screen reduced to a file-name-safe word (`/model` → `model`). */
export function frameFileBase(tool: AgentHealthTool, checkId: string, screen?: string): string {
  const suffix = screen === undefined ? '' : `-${screen.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`;
  return `${tool}-${checkId}${suffix === '-' ? '' : suffix}`;
}

/**
 * Write each judged frame of `check` when the archive keeps it, and return the
 * check with the paths written (`framePaths`). Checks other than `screen-*`,
 * a missing archive and a passing check in `fail` mode come back unchanged.
 */
export function archiveCheckFrames(
  archive: FrameArchive | null | undefined,
  input: {
    tool: AgentHealthTool;
    version?: string | null;
    check: AgentHealthCheck;
    frames: readonly JudgedFrame[];
    now?: Date;
  },
): AgentHealthCheck {
  const { tool, check, frames } = input;
  if (!archive || !check.checkId.startsWith('screen-') || frames.length === 0) return check;
  if (check.status === 'skip') return check;
  if (check.status !== 'fail' && archive.mode !== 'all') return check;

  const written: string[] = [];
  for (const judged of frames) {
    // Nothing was captured (the probe failed before its first look).
    if (judged.frame === '') continue;
    const base = path.join(archive.dir, frameFileBase(tool, check.checkId, judged.screen));
    const meta: FrameMeta = {
      tool,
      checkId: check.checkId,
      ...(judged.screen !== undefined ? { screen: judged.screen } : {}),
      status: check.status,
      summary: check.summary,
      version: input.version ?? null,
      savedAt: (input.now ?? new Date()).toISOString(),
    };
    try {
      fs.mkdirSync(archive.dir, { recursive: true });
      fs.writeFileSync(`${base}.txt`, judged.frame);
      fs.writeFileSync(`${base}.json`, `${JSON.stringify(meta, null, 2)}\n`);
      written.push(`${base}.txt`);
    } catch {
      // The report is what matters; a frame that cannot be kept is just not kept.
    }
  }
  return written.length > 0 ? { ...check, framePaths: written } : check;
}
