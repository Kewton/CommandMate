/**
 * The session labels a pane shows — the model (with the opencode persona in
 * front of it) and the usage line with its tooltip — shared by the PC split
 * (`TerminalSplitPaneContent`) and the phone tab (`MobileTerminalTab`).
 */
import {
  formatAgentModelLabel,
  formatAgentSessionTooltip,
  formatAgentSessionUsage,
} from '@/components/worktree/WorktreeDetailSubComponents';

type SessionLabelArgs = Parameters<typeof formatAgentSessionUsage>;

export function buildPaneSessionLabels(
  model: string | null | undefined,
  agentSession: {
    session: SessionLabelArgs[0];
    context: SessionLabelArgs[1];
  },
  t: SessionLabelArgs[2],
  locale: string | undefined,
): { model: string | null; usage: string | null; usageDetail: string | null } {
  return {
    model: formatAgentModelLabel(model, null, agentSession.session?.agent),
    usage: formatAgentSessionUsage(agentSession.session, agentSession.context, t, locale),
    usageDetail: formatAgentSessionTooltip(agentSession.session, agentSession.context, t, locale),
  };
}
