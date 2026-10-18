/**
 * The "To: <agent> · <branch>" line above a split's composer (Issue #3514),
 * moved out of `TerminalSplitPaneContent` as it was (Issue #3569).
 */
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getInstanceLabel } from '@/lib/cli-tools/types';

type ComposerTargetTranslate = (key: string, values?: Record<string, string>) => string;

export function buildComposerTarget(
  t: ComposerTargetTranslate,
  instance: { cliTool: CLIToolType; alias?: string } | null | undefined,
  cliToolId: CLIToolType,
  branchName: string | null | undefined,
): { text: string; aria: string } {
  // Issue #3514: who this split's composer sends to. The composer stays per
  // split (sharing it is out of scope); this line only says where THIS one
  // goes, which a 2x2 of identical inputs otherwise leaves to the header above.
  const composerAgentLabel = getInstanceLabel(instance ?? { cliTool: cliToolId });
  const composerBranch = branchName?.trim() ? branchName.trim() : null;
  const composerTargetText = composerBranch
    ? t('terminal.composerTarget', { agent: composerAgentLabel, branch: composerBranch })
    : t('terminal.composerTargetNoBranch', { agent: composerAgentLabel });
  const composerTargetAria = composerBranch
    ? t('terminal.composerTargetLabel', { agent: composerAgentLabel, branch: composerBranch })
    : t('terminal.composerTargetLabelNoBranch', { agent: composerAgentLabel });
  return { text: composerTargetText, aria: composerTargetAria };
}
