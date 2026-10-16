/**
 * Issue #3592: the selector's tooltip in the action bar (model and cost lines).
 */

type Translate = (key: string, values?: Record<string, string>) => string;

export function resolveSelectorTitle(
  t: Translate,
  inActionBar: boolean,
  agentModel: string | null | undefined,
  agentUsage: string | null | undefined,
  agentUsageDetail: string | null | undefined,
): string | undefined {
  return inActionBar
    ? [
        agentModel ? t('agentModel.modelLabel', { model: agentModel }) : null,
        agentUsage ? (agentUsageDetail ?? t('agentSession.chipLabel', { usage: agentUsage })) : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n') || undefined
    : undefined;
}
