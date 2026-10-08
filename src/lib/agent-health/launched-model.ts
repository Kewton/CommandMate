/**
 * Which model each probed tool was launched on (Issue #3438).
 *
 * A `pass` check keeps no evidence, so before this the report could not say
 * which model a passing tool ran on — not even whether opencode-v2 picked up
 * the user's `model.json` (#3428). The value is read only where the tool
 * itself shows it, never guessed:
 *
 * - the screen, through the production reader
 *   (`@/lib/detection/model-info-extractor`): claude's banner, codex's footer,
 *   antigravity's bar, command-code's `# models:` row, opencode's `▣  Build ·
 *   <model>` step row and opencode2's `Build · <model> · 721ms` (no `▣`, read
 *   there since #3443).
 * - opencode's composer bar (`┃  Build · <model> <provider>`), the last resort:
 *   after `stripAnsi` the model and the provider are one string (see
 *   `OPENCODE_STEP_MODEL_PATTERN`'s comment), so it is kept whole and marked
 *   `screen-footer`.
 * - the hooks the probe received (`NormalizedAgentEvent.model`: claude's
 *   `SessionStart`, antigravity's `modelName`, …).
 *
 * What none of them shows is `null` — read as 不明. `seeded` is the setting
 * the probe copied in (`model.json`'s `recent[0]`), kept beside the read value
 * so the two can be compared, never used in its place.
 */

import { stripAnsi } from '@/lib/detection/ansi';
import { extractModelInfo } from '@/lib/detection/model-info-extractor';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { isAgentEventType } from '@/lib/hooks/agent-event-types';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { AgentHealthLaunchedModel, AgentHealthLaunchedModelSource } from './types';

/** What a report shows for a tool whose model could not be read, or an old report without the field. */
export const UNKNOWN_LAUNCHED_MODEL = '不明';

const SOURCE_LABELS: Record<AgentHealthLaunchedModelSource, string> = {
  screen: '画面',
  'screen-footer': '画面下端・プロバイダ名を含む',
  hook: 'hook',
};

const MAX_MODEL_CHARS = 64;

/** opencode's composer bar: `┃  Build · <model> <provider>[ · <variant>]`. */
const OPENCODE_COMPOSER_BAR_PATTERN = /^\s*┃\s+[A-Za-z][A-Za-z0-9-]*\s+·\s+([^·]+?)(?:\s+·\s+\S+)?\s*$/;

export interface ScreenModelReading {
  model: string;
  source: 'screen' | 'screen-footer';
}

function plausible(value: string): string | null {
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= MAX_MODEL_CHARS ? trimmed : null;
}

function scanFromEnd(frame: string, pattern: RegExp): string | null {
  const lines = frame.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = pattern.exec(stripAnsi(lines[i]));
    const model = match ? plausible(match[1]) : null;
    if (model) return model;
  }
  return null;
}

/** The model one frame shows, or null when it shows none. */
export function readScreenModel(cliToolId: CLIToolType, frame: string): ScreenModelReading | null {
  if (!frame) return null;
  const read = extractModelInfo(cliToolId, frame).model;
  if (read) return { model: read, source: 'screen' };
  if (cliToolId !== 'opencode' && cliToolId !== 'opencode-v2') return null;
  const bar = scanFromEnd(frame, OPENCODE_COMPOSER_BAR_PATTERN);
  return bar ? { model: bar, source: 'screen-footer' } : null;
}

/**
 * The reading to keep after a new frame: a step row or banner (`screen`) is
 * never replaced by the composer bar; otherwise the newer frame wins.
 */
export function laterScreenModel(
  previous: ScreenModelReading | null,
  next: ScreenModelReading | null
): ScreenModelReading | null {
  if (!next) return previous;
  if (previous?.source === 'screen' && next.source === 'screen-footer') return previous;
  return next;
}

/** The first model a hook payload names, in arrival order (claude's `SessionStart` comes first). */
export function readHookModel(
  cliToolId: CLIToolType,
  deliveries: ReadonlyArray<{ kind: string; event: string | null; body: Record<string, unknown> | null }>
): string | null {
  for (const delivery of deliveries) {
    if (delivery.kind !== 'agent-event' || delivery.body === null) continue;
    try {
      const normalized = getAgentEventSource(cliToolId).normalizeEvent({
        payload: delivery.body,
        event: isAgentEventType(delivery.event) ? delivery.event : null,
      });
      const model = normalized?.model ? plausible(normalized.model) : null;
      if (model) return model;
    } catch {
      // A payload the source cannot read names no model.
    }
  }
  return null;
}

/** `<providerID>/<modelID>` of `model.json`'s `recent[0]`, or null. */
export function readSeededModel(text: string | null): string | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { recent?: unknown };
    if (!Array.isArray(parsed?.recent)) return null;
    const first = parsed.recent[0] as { providerID?: unknown; modelID?: unknown } | undefined;
    if (typeof first?.modelID !== 'string' || first.modelID === '') return null;
    return typeof first.providerID === 'string' && first.providerID !== ''
      ? `${first.providerID}/${first.modelID}`
      : first.modelID;
  } catch {
    return null;
  }
}

/** The screen's step row or banner, then the hooks, then the composer bar; null when none. */
export function resolveLaunchedModel(input: {
  screen: ScreenModelReading | null;
  hook: string | null;
  seeded?: string | null;
}): AgentHealthLaunchedModel {
  const seeded = input.seeded ? { seeded: input.seeded } : {};
  if (input.screen?.source === 'screen') return { model: input.screen.model, source: 'screen', ...seeded };
  if (input.hook) return { model: input.hook, source: 'hook', ...seeded };
  if (input.screen) return { model: input.screen.model, source: input.screen.source, ...seeded };
  return { model: null, ...seeded };
}

/**
 * One line for the summary: `Haiku 4.5（画面）`, `不明`, `不明（設定: github-copilot/…）`.
 * A report written before #3438 has no `launchedModel` and reads 不明.
 */
export function launchedModelLabel(launched: AgentHealthLaunchedModel | null | undefined): string {
  const model = typeof launched?.model === 'string' && launched.model !== '' ? launched.model : null;
  const source = launched?.source && SOURCE_LABELS[launched.source] ? SOURCE_LABELS[launched.source] : null;
  const notes = [
    ...(model && source ? [source] : []),
    ...(typeof launched?.seeded === 'string' && launched.seeded !== '' ? [`設定: ${launched.seeded}`] : []),
  ];
  const head = model ?? UNKNOWN_LAUNCHED_MODEL;
  return notes.length > 0 ? `${head}（${notes.join('・')}）` : head;
}
