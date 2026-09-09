/**
 * Issue #2442: the generated `permissions.deny` refuses socket-less tmux calls.
 *
 * ## Why a model, and why this model
 *
 * The rules are enforced by Claude Code, not by this repository, so a unit test
 * can only assert that the *strings* are right. What makes "right" checkable is
 * {@link isDeniedBy}: a matcher written from measurements taken against the
 * installed CLI (**2.1.266**, macOS 26.6.2 / arm64, 2026-09-09) and recorded in
 * `docs/design/agent-hooks-permission-deny-verification.md` §6. Every rule in the
 * model below is a row in that table, with the harmless read-only stand-in it was
 * measured with:
 *
 *  - Prefix matching is **token-exact and adjacency-sensitive**. A rule naming
 *    `tmux list-p` left `tmux list-panes` alone (§6 X); one naming
 *    `tmux show-options -g` left `tmux show-options -gv …` (Z1) and
 *    `tmux show-options -t 0 -g` (Z2) alone while refusing
 *    `tmux show-options -g history-limit` (Z3).
 *  - A command line is **decomposed** and each part matched on its own:
 *    `&&` (F), `|` (G), `;` (H), `||` (I), a newline after an assignment (J) and
 *    `$( … )` (T) were all refused.
 *  - A **leading `env VAR=…`** is stripped before matching (N was refused).
 *  - The shapes that are *not* refused are measured too, and are asserted below
 *    rather than assumed: absolute path (K), `bash -c` (M), a different global
 *    option before the subcommand (U), tmux's own alias `ls` (V), an abbreviated
 *    subcommand (W).
 *
 * The model is deliberately not the narrowest thing that passes: it reproduces
 * the escapes as well as the refusals, so the limitation table in the design doc
 * and this suite cannot drift apart.
 *
 * ## Safety
 *
 * Every command below is a **string**. Nothing here is passed to a shell, and no
 * destructive spelling was ever typed against a real server while measuring —
 * the live probe used read-only stand-ins (`list-sessions`, `show-options -g`,
 * `list-keys`) sharing each rule's argv shape, plus `-L cmate-2442-probe`
 * controls against a socket with no server on it.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  PERMISSION_DENY_RULES,
  TMUX_UNPINNED_DENY_RULES,
} from '@/lib/hooks/hook-settings-generator';

/** The three process-kill rules from Issue #1739, which must survive unchanged. */
const PROCESS_KILL_RULES = ['Bash(pkill:*)', 'Bash(killall:*)', 'Bash(kill -9:*)'];

/** Split a command line the way the CLI was measured to (§6 F/G/H/I/J/T). */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]|\$\(|`|\)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

/** Drop a leading `env VAR=…` / bare `VAR=…` prefix (§6 N). */
function withoutEnvPrefix(segment: string): string {
  let rest = segment.replace(/^env\s+/, '');
  for (;;) {
    const stripped = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '');
    if (stripped === rest) return rest;
    rest = stripped;
  }
}

/** Token-exact, adjacency-sensitive prefix match (§6 X/Y/Z1/Z2/Z3). */
function matchesPrefix(segment: string, prefix: string): boolean {
  const words = withoutEnvPrefix(segment).split(/\s+/);
  const wanted = prefix.split(/\s+/);
  if (words.length < wanted.length) return false;
  return wanted.every((word, index) => words[index] === word);
}

function isDeniedBy(rules: readonly string[], command: string): boolean {
  const prefixes = rules.map((rule) => {
    const match = /^Bash\((.*):\*\)$/.exec(rule);
    if (!match) throw new Error(`not a Bash prefix rule: ${rule}`);
    return match[1];
  });
  return segments(command).some((segment) =>
    prefixes.some((prefix) => matchesPrefix(segment, prefix))
  );
}

describe('the model matches what the CLI was measured to do', () => {
  // Without this block the suite would be asserting against a matcher nobody
  // checked. Each row is a stand-in measurement from §6, replayed through the
  // model with the stand-in rules it was measured with.
  const STAND_IN_RULES = [
    'Bash(tmux list-sessions:*)',
    'Bash(tmux show-options -g:*)',
    'Bash(tmux list-keys:*)',
  ];

  it.each([
    ['tmux list-sessions', true, 'A — bare call'],
    ['tmux -L cmate-2442-probe list-sessions', false, 'B — socket-pinned control, executed'],
    ['tmux show-options -g', true, 'C — flagged prefix'],
    ['tmux -L cmate-2442-probe show-options -g', false, 'D — pinned control, executed'],
    ['tmux list-keys', true, 'E — key-table read'],
    ['cd /tmp && tmux list-sessions', true, 'F — && composition'],
    ['tmux list-sessions | cat', true, 'G — pipeline'],
    ['echo start; tmux list-sessions', true, 'H — semicolon'],
    ['false || tmux list-sessions', true, 'I — || composition'],
    ['export CM_PROBE_MARKER=1\ntmux list-sessions', true, 'J — the accident shape'],
    ['/opt/homebrew/bin/tmux list-sessions', false, 'K — absolute path, NOT refused'],
    ["bash -c 'tmux list-sessions'", false, 'M — bash -c, NOT refused'],
    ['env CM_PROBE=1 tmux list-sessions', true, 'N — env prefix'],
    ['tmux -S /tmp/probe.sock list-sessions', false, 'P — -S control'],
    ['echo "$(tmux list-sessions)"', true, 'T — command substitution'],
    ['tmux -u list-sessions', false, 'U — another global option, NOT refused'],
    ['tmux ls', false, 'V — tmux alias, NOT refused'],
    ['tmux list-sess', false, 'W — abbreviation, NOT refused'],
    ['tmux show-options -gv history-limit', false, 'Z1 — combined flag, NOT refused'],
    ['tmux show-options -t 0 -g', false, 'Z2 — non-adjacent -g, NOT refused'],
    ['tmux show-options -g history-limit', true, 'Z3 — adjacency control'],
  ])('%s -> denied=%s (%s)', (command, expected) => {
    expect(isDeniedBy(STAND_IN_RULES, command)).toBe(expected);
  });

  it('reproduces the truncated-prefix measurement that ruled out family rules', () => {
    // §6 X/Y: `Bash(tmux list-p:*)` did NOT refuse `tmux list-panes`. This is why
    // each alias needs its own row instead of one shorter rule covering a family.
    expect(isDeniedBy(['Bash(tmux list-p:*)'], 'tmux list-panes')).toBe(false);
    expect(isDeniedBy(['Bash(tmux list:*)'], 'tmux list-keys')).toBe(false);
  });
});

describe('socket-less tmux deny rules (Issue #2442)', () => {
  it.each([
    ['tmux kill-server', 'the word that wiped 42 sessions on 2026-09-08'],
    ['tmux kill-server -t whatever', 'with arguments'],
    ['tmux kill-session', 'no target at all'],
    ["tmux kill-session -t '=mcbd-claude-wt:'", 'the exact-match teardown idiom, unpinned'],
    ['tmux set-option -g history-limit 200000', 'a server-global option'],
    ['tmux set -g status off', "tmux's own alias for set-option"],
    ['tmux bind-key -T root q detach-client', 'the shared key table'],
    ['tmux bind q detach-client', "tmux's own alias for bind-key"],
    ['tmux unbind-key -a', 'clearing every binding'],
    ['tmux unbind q', "tmux's own alias for unbind-key"],
  ])('denies %s (%s)', (command) => {
    expect(isDeniedBy(PERMISSION_DENY_RULES, command)).toBe(true);
  });

  it.each([
    ['cd /tmp && tmux kill-server', 'hidden behind a cd'],
    ['tmux kill-server | cat', 'hidden in a pipeline'],
    ['echo tearing down; tmux kill-server', 'hidden after a semicolon'],
    ['tmux has-session -t x || tmux kill-server', 'hidden behind a guard'],
    ['export TMUX_TMPDIR=/tmp/probe\ntmux kill-server', 'the 2026-09-08 accident, verbatim shape'],
    ['echo "$(tmux kill-server)"', 'inside a command substitution'],
    ['env FOO=1 tmux kill-server', 'behind an env prefix'],
  ])('denies %s (%s)', (command) => {
    // The composed spellings matter more than the bare one: the accident was
    // never a lone `tmux kill-server`, it was the last line of a block.
    expect(isDeniedBy(PERMISSION_DENY_RULES, command)).toBe(true);
  });

  it.each([
    ['tmux -L cmate-probe kill-server', '-L, the isolated-probe teardown'],
    ['tmux -S /tmp/cmate-probe.sock kill-server', '-S, a socket path'],
    ["tmux -L cmate-probe kill-session -t '=probe:'", 'a pinned exact-match kill'],
    ['tmux -L cmate-probe set-option -g history-limit 200000', 'a pinned global option'],
    ['tmux -L cmate-probe bind-key -T root q detach-client', 'a pinned key binding'],
    ['tmux -L cmate-probe unbind-key -a', 'a pinned unbind'],
  ])('leaves %s alone (%s)', (command) => {
    // Measured live: B/D/R/R2 in §6 all executed and reached tmux itself. "Not
    // denied" means no new rule matches — the session's ordinary permission
    // handling still applies.
    expect(isDeniedBy(TMUX_UNPINNED_DENY_RULES, command)).toBe(false);
  });

  it.each([
    ['tmux list-sessions', 'a read-only call'],
    ['tmux capture-pane -p -t x', 'reading a pane'],
    ['tmux new-session -d -s probe', 'creating a session'],
    ['tmux send-keys -t x C-c', 'sending keys'],
    ['tmux set-option -t probe history-limit 200000', 'a SESSION-scoped option'],
    ['tmux show-options -g', 'reading the global options'],
    ['tmux kill-pane -t x', 'destroying one pane'],
    ['npm run kill-server-orphans', 'a script whose name contains the word'],
    ['git commit -m "deny tmux kill-server"', 'the rule quoted inside prose'],
  ])('leaves %s alone (%s)', (command) => {
    // The rules are about *server-wide* destruction and *server-global* mutation.
    // Everything a session legitimately does to itself has to keep working, or
    // agents reach for a worse spelling.
    expect(isDeniedBy(TMUX_UNPINNED_DENY_RULES, command)).toBe(false);
  });

  it.each([
    ['/opt/homebrew/bin/tmux kill-server', 'an absolute path'],
    ["bash -c 'tmux kill-server'", 'a nested shell'],
    ['tmux -u kill-server', 'a different global option first'],
    ['tmux kill-serv', "tmux's unambiguous-prefix abbreviation"],
    ['tmux set -ga status-format[0] x', 'a combined global flag'],
  ])('does NOT claim to stop %s (%s)', (command) => {
    // Recorded, not wished away. §6.4 of the design doc carries the same list;
    // this test is what keeps the doc honest if the CLI's matcher ever widens —
    // it will fail, and the doc will have to be re-measured.
    expect(isDeniedBy(PERMISSION_DENY_RULES, command)).toBe(false);
  });
});

describe('the existing rules and their shape are preserved', () => {
  it('keeps the three process-kill rules, first and in order', () => {
    // Issue #1739's rules are the reason a `pkill -f` cannot reach a server the
    // worker cannot see. Appending must not reorder or drop them.
    expect(PERMISSION_DENY_RULES.slice(0, 3)).toEqual(PROCESS_KILL_RULES);
  });

  it('is exactly the process-kill rules plus the tmux rules', () => {
    expect([...PERMISSION_DENY_RULES]).toEqual([
      ...PROCESS_KILL_RULES,
      ...TMUX_UNPINNED_DENY_RULES,
    ]);
  });

  it('still denies the command that stopped the production server on 2026-08-06', () => {
    expect(isDeniedBy(PERMISSION_DENY_RULES, 'pkill -f "node dist/server/server.js"')).toBe(true);
  });

  it('still leaves the pid-file idiom the docs recommend alone', () => {
    expect(isDeniedBy(PERMISSION_DENY_RULES, 'kill "$(cat uat.pid)"')).toBe(false);
    expect(isDeniedBy(PERMISSION_DENY_RULES, 'kill -TERM 4242')).toBe(false);
  });

  it('states every rule in the prefix form Claude honours', () => {
    for (const rule of TMUX_UNPINNED_DENY_RULES) {
      expect(rule, `${rule} is not a Bash prefix rule`).toMatch(/^Bash\(\S(?:.*\S)?:\*\)$/);
    }
  });

  it('names tmux first in every new rule, since that is what the matcher compares', () => {
    // A rule that named the subcommand alone (`Bash(kill-server:*)`) would load
    // without error and match nothing, because matching starts at the first word.
    for (const rule of TMUX_UNPINNED_DENY_RULES) {
      expect(rule.startsWith('Bash(tmux ')).toBe(true);
    }
  });

  it('carries no duplicate rules', () => {
    expect(new Set(PERMISSION_DENY_RULES).size).toBe(PERMISSION_DENY_RULES.length);
  });
});
