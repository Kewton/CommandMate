import { stripAnsi } from '@/lib/detection/cli-patterns';

interface ParsedAssistantOutput {
  finalMessage: string | null;
  resumeSessionId: string | null;
}

function collectStringValues(value: unknown, values: string[]): void {
  if (typeof value === 'string' && value.trim() !== '') {
    values.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, values);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectStringValues(nested, values);
    }
  }
}

function findResumeSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, nested] of entries) {
    if (
      typeof nested === 'string' &&
      ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId']
        .includes(key)
    ) {
      return nested;
    }
  }

  for (const [, nested] of entries) {
    const candidate = findResumeSessionId(nested);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractCandidateMessage(parsed: Record<string, unknown>): string | null {
  const directCandidates = [
    parsed.final_message,
    parsed.finalMessage,
    parsed.text,
    parsed.content,
    parsed.message,
    parsed.output,
    parsed.result,
  ];

  const values: string[] = [];
  for (const candidate of directCandidates) {
    collectStringValues(candidate, values);
  }

  const joined = values.join('\n').trim();
  return joined || null;
}

function parseStructuredStdout(stdout: string): ParsedAssistantOutput {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let lastMessage: string | null = null;
  let resumeSessionId: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const candidateMessage = extractCandidateMessage(parsed);
      if (candidateMessage) {
        lastMessage = candidateMessage;
      }

      const candidateResumeId = findResumeSessionId(parsed);
      if (candidateResumeId) {
        resumeSessionId = candidateResumeId;
      }
    } catch {
      // Ignore malformed lines. Structured output is best-effort parsed line by line.
    }
  }

  return {
    finalMessage: lastMessage ? stripAnsi(lastMessage).trim() : null,
    resumeSessionId,
  };
}

export function parseClaudeStructuredOutput(stdout: string): ParsedAssistantOutput {
  return parseStructuredStdout(stdout);
}

function extractCodexAgentMessage(parsed: Record<string, unknown>): string | null {
  if (parsed.type !== 'item.completed') {
    return null;
  }

  const item = parsed.item;
  if (!item || typeof item !== 'object') {
    return null;
  }

  const itemRecord = item as Record<string, unknown>;
  if (itemRecord.type !== 'agent_message') {
    return null;
  }

  const text = itemRecord.text;
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

export function parseCodexStructuredOutput(stdout: string): ParsedAssistantOutput {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let lastMessage: string | null = null;
  let resumeSessionId: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      const agentMessage = extractCodexAgentMessage(parsed);
      if (agentMessage) {
        lastMessage = agentMessage;
      }

      const candidateResumeId = findResumeSessionId(parsed);
      if (candidateResumeId) {
        resumeSessionId = candidateResumeId;
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return {
    finalMessage: lastMessage ? stripAnsi(lastMessage).trim() : null,
    resumeSessionId,
  };
}
