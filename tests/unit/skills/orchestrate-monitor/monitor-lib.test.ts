import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh',
);
const CLI_TOOL_TYPES = path.join(process.cwd(), 'src/lib/cli-tools/types.ts');
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

const ESC = '\u001b'; // JSON.stringify writes this as the 6 characters \u001b
const NBSP = '\u00a0'; // written raw; JSON does not escape it

/** Run a snippet with monitor-lib.sh sourced; returns stdout. */
function sh(snippet: string): string {
  return execFileSync('bash', ['-c', `set -u; . "${LIB}"; ${snippet}`], {
    encoding: 'utf8',
  });
}

/** yes/no for a predicate helper, so a swallowed exit code never reads as a pass. */
function predicateFile(fn: string, file: string): boolean {
  const out = sh(`if ${fn} "${file}"; then echo yes; else echo no; fi`).trim();
  expect(out).toMatch(/^(yes|no)$/);
  return out === 'yes';
}

function predicate(fn: string, fixture: string): boolean {
  return predicateFile(fn, path.join(FIXTURES, fixture));
}

/** Write a payload the way `capture --json` does: JSON.stringify(payload, null, 2). */
function tmpJson(payload: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ml-test-'));
  const file = path.join(dir, 'poll.json');
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

function tmpText(body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ml-test-'));
  const file = path.join(dir, 'pane.txt');
  writeFileSync(file, body);
  return file;
}

describe('ml_strip_ansi', () => {
  it('removes JSON-escaped CSI sequences, the form capture --json emits', () => {
    // On disk this is the six characters backslash-u-0-0-1-b, not an ESC byte —
    // which is why the pre-#1522 anchor `↓ [0-9]` never matched a real capture.
    const file = tmpJson({
      realtimeSnippet: `(4m 25s · ↓${ESC}[39m ${ESC}[38;5;246m14.9k tokens`,
    });
    expect(sh(`ml_strip_ansi "${file}"`)).toContain('↓ 14.9k tokens');
  });

  it('removes raw ESC CSI sequences too (a capture piped as plain text)', () => {
    const file = tmpText(`${ESC}[38;5;246m↓${ESC}[39m 14.9k tokens${ESC}[0m\n`);
    expect(sh(`ml_strip_ansi "${file}"`).trim()).toBe('↓ 14.9k tokens');
  });

  it('normalizes the non-breaking space the TUI puts after a marker', () => {
    // `❯<nbsp>` and `⎿ <nbsp>Tip:` both appear in the real captures. Left alone
    // the nbsp defeats `❯ [0-9]+\.` for the same reason ANSI defeated `↓ [0-9]`.
    const file = tmpText(`❯${NBSP}1. Submit answers\n`);
    expect(sh(`ml_strip_ansi "${file}"`).trim()).toBe('❯ 1. Submit answers');
  });

  it('reads stdin when called with no argument', () => {
    expect(sh(`printf 'a\\\\u001b[39mb\\n' | ml_strip_ansi`).trim()).toBe('ab');
  });
});

describe('ml_pane_text scopes anchors to the current pane', () => {
  it('returns realtimeSnippet and ignores the scrollback in content', () => {
    const file = tmpJson({
      isRunning: true,
      content: 'task text mentioning ml_has_rate_limit and usage limit reached',
      realtimeSnippet: `${ESC}[38;5;246m⏺ working${ESC}[39m`,
    });
    const out = sh(`ml_pane_text "${file}"`);
    expect(out).toContain('⏺ working');
    expect(out).not.toContain('ml_has_rate_limit');
    expect(out).not.toContain('usage limit reached');
  });

  it('falls back to the whole file when there is no realtimeSnippet', () => {
    // The session_not_running payload carries no pane at all.
    const file = tmpJson({ isRunning: false, content: 'no pane here' });
    expect(sh(`ml_pane_text "${file}"`)).toContain('no pane here');
  });
});

describe('ml_is_retrying', () => {
  it('is true during the CLI’s own backoff (live 529 capture)', () => {
    expect(predicate('ml_is_retrying', 'live-retrying-529.json')).toBe(true);
  });

  it('is false once the retries are exhausted, even with `attempt 10/10` on screen', () => {
    // The idle-footer veto. Without it a dead session reads as alive forever and
    // monitor.sh never reaches the resend path.
    expect(predicate('ml_is_retrying', 'live-api-error-exhausted.json')).toBe(false);
  });

  it('is true for a 429 backoff, which is why it outranks the rate-limit branch', () => {
    const file = tmpJson({
      isRunning: true,
      realtimeSnippet:
        `${ESC}[38;5;211m✻${ESC}[39m 429 Too Many Requests${ESC}[38;5;246m · Retrying in 30s · attempt 3/10${ESC}[39m\n` +
        `  ⏸ manual mode on · esc to interrupt · ← for agents`,
    });
    expect(predicateFile('ml_is_retrying', file)).toBe(true);
    expect(predicateFile('ml_has_rate_limit', file)).toBe(true);
  });

  it('is false on an ordinary idle pane', () => {
    expect(predicate('ml_is_retrying', 'live-idle.json')).toBe(false);
  });
});

describe('ml_has_rate_limit is limited to product banner wording', () => {
  it('matches the real usage-limit banner', () => {
    expect(predicate('ml_has_rate_limit', 'rate-limit.json')).toBe(true);
  });

  it('does not match rate-limiter source or prose on screen', () => {
    // The 5th defect: a bare `rate.?limit` alternative matched `rate_limit` /
    // `rate-limit` anywhere and fired `send-keys a Enter` at healthy workers.
    expect(predicate('ml_has_rate_limit', 'live-idle-rate-limit-source.json')).toBe(false);
  });

  it('does not match the task text sitting in scrollback', () => {
    expect(
      predicate('ml_has_rate_limit', 'live-generating-task-text-scrollback.json'),
    ).toBe(false);
  });
});

describe('ml_has_terminal_api_error', () => {
  it('is true for retries exhausted with the error still on the pane', () => {
    expect(predicate('ml_has_terminal_api_error', 'live-api-error-exhausted.json')).toBe(true);
  });

  it('is false while the CLI is still retrying', () => {
    expect(predicate('ml_has_terminal_api_error', 'live-retrying-529.json')).toBe(false);
  });

  it('is false on a healthy idle pane, so no resend is injected into a finished worker', () => {
    expect(predicate('ml_has_terminal_api_error', 'live-idle.json')).toBe(false);
    expect(predicate('ml_has_terminal_api_error', 'idle-brewed-summary.json')).toBe(false);
  });
});

describe('ml_has_gen_anchor / ml_has_idle_footer', () => {
  it('the gen anchor fires on the ANSI-split token counter', () => {
    expect(predicate('ml_has_gen_anchor', 'live-generating-token.json')).toBe(true);
  });

  it('the gen anchor does not fire on the completion summary (↑ tokens)', () => {
    expect(predicate('ml_has_gen_anchor', 'idle-brewed-summary.json')).toBe(false);
  });

  it('the idle footer is present only when the turn is over', () => {
    expect(predicate('ml_has_idle_footer', 'live-idle.json')).toBe(true);
    expect(predicate('ml_has_idle_footer', 'live-generating-token.json')).toBe(false);
  });
});

describe('ml_has_prompt_marker', () => {
  it('matches AskUserQuestion’s selection marker', () => {
    expect(predicate('ml_has_prompt_marker', 'prompt-submit-answers.json')).toBe(true);
  });

  it('matches when the marker is separated from the option by ANSI + nbsp', () => {
    const file = tmpJson({
      isRunning: true,
      realtimeSnippet: `${ESC}[38;5;246m❯${NBSP}${ESC}[1m1. Submit answers${ESC}[0m`,
    });
    expect(predicateFile('ml_has_prompt_marker', file)).toBe(true);
  });

  it('does not match the bare composer prompt or a queued message', () => {
    // `❯<nbsp>` (empty composer) and `❯ a` (a stray queued keystroke) are not prompts.
    expect(predicate('ml_has_prompt_marker', 'live-idle.json')).toBe(false);
    expect(predicate('ml_has_prompt_marker', 'live-retrying-529.json')).toBe(false);
  });
});

/**
 * Issue #1601. The shipped default was `SESSION_PREFIX="cm"`, i.e. every
 * intervention was typed at `cm-<worktree-id>` — a session that has never
 * existed, since the product builds `mcbd-<cliToolId>-<worktreeId>`. These
 * helpers replace the concatenation with a derivation from the capture payload.
 */
describe('session-name derivation', () => {
  /** Capture the exit status too: a helper that fails silently reads as "empty". */
  function call(snippet: string): { out: string; status: string } {
    const raw = sh(`out=$(${snippet}); echo "status=$?"; printf '%s' "$out"`);
    const [first, ...rest] = raw.split('\n');
    return { status: first.replace('status=', ''), out: rest.join('\n') };
  }

  describe('ml_session_name', () => {
    it('builds the primary session from the payload cliToolId', () => {
      expect(call('ml_session_name w1 claude').out).toBe('mcbd-claude-w1');
      expect(call('ml_session_name w1 codex').out).toBe('mcbd-codex-w1');
      // The pre-#1601 target, spelled out: nothing derives it any more.
      expect(call('ml_session_name w1 claude').out).not.toBe('cm-w1');
    });

    it('treats an instance id equal to the tool as the primary instance', () => {
      // getSessionName() keeps the original name for the primary
      // (instanceId === cliToolId) for backward compatibility.
      expect(call('ml_session_name w1 claude claude').out).toBe('mcbd-claude-w1');
    });

    it('strips the tool prefix from a non-primary instance id', () => {
      // deriveSessionSuffix('claude-2', 'claude') === '2', so the session is
      // mcbd-claude-w1-2 rather than a redundant mcbd-claude-w1-claude-2.
      expect(call('ml_session_name w1 claude claude-2').out).toBe('mcbd-claude-w1-2');
      expect(call('ml_session_name w1 codex codex-3').out).toBe('mcbd-codex-w1-3');
    });

    it('uses an instance id that does not carry the tool prefix verbatim', () => {
      expect(call('ml_session_name w1 claude helper').out).toBe('mcbd-claude-w1-helper');
    });

    it('lets --session-prefix replace the derived head but keeps the suffix', () => {
      expect(call('ml_session_name w1 claude "" legacy').out).toBe('legacy-w1');
      expect(call('ml_session_name w1 claude claude-2 legacy').out).toBe('legacy-w1-2');
    });

    it('fails instead of inventing a name when nothing can be derived', () => {
      // No cliToolId in the payload and no override. Returning something here is
      // how a target that matched no session survived for four releases.
      const missingTool = call('ml_session_name w1 ""');
      expect(missingTool).toEqual({ status: '1', out: '' });
      expect(call('ml_session_name "" claude')).toEqual({ status: '1', out: '' });
    });
  });

  describe('ml_agent_from_instance', () => {
    it('recovers the tool from an instance id', () => {
      expect(call('ml_agent_from_instance codex-2').out).toBe('codex');
      expect(call('ml_agent_from_instance claude').out).toBe('claude');
    });

    it('handles the tool id that contains a hyphen', () => {
      // Cutting at the first hyphen would yield `vibe`, which is not a tool, so
      // the capture would silently fall back to the worktree's default agent.
      expect(call('ml_agent_from_instance vibe-local-2').out).toBe('vibe-local');
      expect(call('ml_agent_from_instance vibe-local').out).toBe('vibe-local');
    });

    it('fails for an id that belongs to no known tool', () => {
      expect(call('ml_agent_from_instance helper-2')).toEqual({ status: '1', out: '' });
      expect(call('ml_agent_from_instance ""')).toEqual({ status: '1', out: '' });
    });

    it('knows exactly the tools the product knows', () => {
      // A drifted list stops resolving `--agent` for the tools it lost, which puts
      // the capture on the worktree's default pane while the loop believes it is
      // watching the instance — the same silent miss as #1601, one layer down.
      const source = readFileSync(CLI_TOOL_TYPES, 'utf8');
      const literal = /export const CLI_TOOL_IDS = \[([^\]]+)\] as const;/.exec(source);
      expect(literal).not.toBeNull();
      const ids = [...(literal as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThanOrEqual(7);

      expect(sh('printf "%s" "$ML_CLI_TOOL_IDS"').split(' ')).toEqual(ids);
    });
  });

  describe('ml_tmux_target', () => {
    it('builds the exact-match specifier, so a target cannot leak to a prefix', () => {
      // exactTarget() (Issue #1156): `mcbd-claude-w1` is a prefix of
      // `mcbd-claude-w1-2`, and a bare `-t` target prefix-matches when nothing
      // matches exactly. The trailing `:` is required for send-keys, which parses
      // a bare `=name` as a pane spec and fails.
      expect(call('ml_tmux_target mcbd-claude-w1').out).toBe('=mcbd-claude-w1:');
    });
  });
});
