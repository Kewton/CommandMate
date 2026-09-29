/**
 * Issue #2953: the opencode (v1) probe sets launchEnv to isolate the TUI state
 * (prompt history, model picks, locks) in $XDG_STATE_HOME/opencode from the user's
 * ~/.local/state/opencode/.
 *
 * Pinned by matching the geometry and launch line semantics established for
 * opencode-v2 in Issue #2937.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { getAgentEventSource, renderAgentLaunchCommand } from '@/lib/hooks/sources';
import { buildProbeLaunchCommand } from '../../../../scripts/agent-health/probe-tool';
import { TOOL_PROBE_SPECS } from '../../../../scripts/agent-health/tool-table';

describe('opencode (v1) in the tool table (Issue #2953)', () => {
  it('keeps the TUI state out of the user home', () => {
    const env = TOOL_PROBE_SPECS.opencode.launchEnv?.('/tmp/cm-agent-health-x/opencode');
    expect(env).toEqual({ XDG_STATE_HOME: '/tmp/cm-agent-health-x/opencode-xdg-state' });
    const line = buildProbeLaunchCommand(TOOL_PROBE_SPECS.opencode, 'opencode', '/w/opencode');
    expect(line).toBe("XDG_STATE_HOME='/w/opencode-xdg-state' opencode");
  });

  it('prepends XDG_STATE_HOME to rendered launch command from prepareLaunch', () => {
    const target = {
      worktreeId: 'cm-probe',
      cliToolId: 'opencode' as const,
      instanceId: 'probe-opencode',
    };
    const rendered = renderAgentLaunchCommand(
      getAgentEventSource('opencode').prepareLaunch({
        target,
        executablePath: 'opencode',
        worktreePath: '/w/opencode',
      })
    );
    const line = buildProbeLaunchCommand(TOOL_PROBE_SPECS.opencode, rendered, '/w/opencode');
    expect(line).toBe(`XDG_STATE_HOME='/w/opencode-xdg-state' ${rendered}`);
  });
});
