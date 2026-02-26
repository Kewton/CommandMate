/**
 * API Route: /api/ollama/models
 * GET: Returns available Ollama models from the local Ollama server
 *
 * Issue #368: Ollama model selection for vibe-local
 */

import { NextResponse } from 'next/server';

/** Timeout for Ollama API requests (ms) */
const OLLAMA_TIMEOUT_MS = 3000;

/** Ollama API base URL */
const OLLAMA_API_URL = 'http://localhost:11434/api/tags';

/** Model info returned to the client */
interface OllamaModelInfo {
  name: string;
  size: number;
  parameterSize: string;
}

export async function GET() {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    const response = await fetch(OLLAMA_API_URL, {
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      return NextResponse.json(
        { models: [], error: `Ollama returned status ${response.status}` },
        { status: 200 }
      );
    }

    const data = await response.json() as {
      models?: Array<{
        name?: string;
        size?: number;
        details?: { parameter_size?: string };
      }>;
    };

    const models: OllamaModelInfo[] = (data.models ?? []).map((m) => ({
      name: typeof m.name === 'string' ? m.name : '',
      size: typeof m.size === 'number' ? m.size : 0,
      parameterSize: typeof m.details?.parameter_size === 'string' ? m.details.parameter_size : '',
    })).filter((m) => m.name.length > 0);

    return NextResponse.json({ models }, { status: 200 });
  } catch (error) {
    // Ollama not running or network error - return empty list gracefully
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { models: [], error: `Ollama is not available: ${message}` },
      { status: 200 }
    );
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
