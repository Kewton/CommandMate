/**
 * API Client Utilities
 * Type-safe fetch wrapper for backend API calls
 */

import type { Worktree, ChatMessage } from '@/types/models';

/**
 * Repository summary from API
 */
export interface RepositorySummary {
  path: string;
  name: string;
  worktreeCount: number;
}

/**
 * Worktrees API response
 */
export interface WorktreesResponse {
  worktrees: Worktree[];
  repositories: RepositorySummary[];
}

/**
 * API Error class
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: any
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Base fetch wrapper with error handling
 */
async function fetchApi<T>(url: string, options?: RequestInit): Promise<T> {
  try {
    // Get auth token from environment variable (exposed via next.config.js)
    const authToken = process.env.NEXT_PUBLIC_MCBD_AUTH_TOKEN;

    const headers = new Headers(options?.headers);
    headers.set('Content-Type', 'application/json');

    // Add Bearer token if available
    if (authToken) {
      headers.set('Authorization', `Bearer ${authToken}`);
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(
        error.error || `HTTP error ${response.status}`,
        response.status,
        error
      );
    }

    return response.json();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      error instanceof Error ? error.message : 'Unknown error',
      0
    );
  }
}

/**
 * Worktree API client
 */
export const worktreeApi = {
  /**
   * Get all worktrees and repositories
   */
  async getAll(): Promise<WorktreesResponse> {
    return fetchApi<WorktreesResponse>('/api/worktrees');
  },

  /**
   * Get a specific worktree by ID
   */
  async getById(id: string): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`);
  },

  /**
   * Update worktree memo
   */
  async updateMemo(id: string, memo: string): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ memo }),
    });
  },

  /**
   * Update worktree link
   */
  async updateLink(id: string, link: string): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ link }),
    });
  },

  /**
   * Toggle worktree favorite status
   */
  async toggleFavorite(id: string, favorite: boolean): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ favorite }),
    });
  },

  /**
   * Update worktree status
   */
  async updateStatus(id: string, status: 'todo' | 'doing' | 'done' | null): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  /**
   * Update worktree CLI tool
   */
  async updateCliTool(id: string, cliToolId: 'claude' | 'codex' | 'gemini'): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}/cli-tool`, {
      method: 'PATCH',
      body: JSON.stringify({ cliToolId }),
    });
  },

  /**
   * Get messages for a worktree, optionally filtered by CLI tool
   */
  async getMessages(id: string, cliTool?: 'claude' | 'codex' | 'gemini'): Promise<ChatMessage[]> {
    const params = new URLSearchParams();
    if (cliTool) {
      params.append('cliTool', cliTool);
    }
    const url = `/api/worktrees/${id}/messages${params.toString() ? `?${params.toString()}` : ''}`;
    return fetchApi<ChatMessage[]>(url);
  },

  /**
   * Send a message to a worktree
   * @param id - Worktree ID
   * @param content - Message content
   * @param cliToolId - Optional CLI tool ID (claude, codex, gemini)
   */
  async sendMessage(id: string, content: string, cliToolId?: 'claude' | 'codex' | 'gemini'): Promise<{ success: boolean }> {
    const body: { content: string; cliToolId?: string } = { content };
    if (cliToolId) {
      body.cliToolId = cliToolId;
    }
    return fetchApi<{ success: boolean }>(`/api/worktrees/${id}/send`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /**
   * Get log files for a worktree
   */
  async getLogs(id: string): Promise<string[]> {
    return fetchApi<string[]>(`/api/worktrees/${id}/logs`);
  },

  /**
   * Get content of a specific log file
   */
  async getLogFile(id: string, filename: string): Promise<{
    filename: string;
    content: string;
    size: number;
    modifiedAt: string;
  }> {
    return fetchApi(`/api/worktrees/${id}/logs/${filename}`);
  },

  /**
   * Kill the tmux session for a worktree
   * @param id - Worktree ID
   * @param cliToolId - Optional CLI tool ID (claude, codex, gemini). If not specified, uses worktree's default.
   */
  async killSession(id: string, cliToolId?: 'claude' | 'codex' | 'gemini'): Promise<{ success: boolean; message: string }> {
    return fetchApi<{ success: boolean; message: string }>(
      `/api/worktrees/${id}/kill-session`,
      {
        method: 'POST',
        body: cliToolId ? JSON.stringify({ cliToolId }) : undefined,
      }
    );
  },
};

/**
 * Repository API client
 */
export const repositoryApi = {
  /**
   * Scan a new repository path for worktrees
   */
  async scan(repositoryPath: string): Promise<{
    success: boolean;
    message: string;
    worktreeCount: number;
    repositoryPath: string;
    repositoryName: string;
  }> {
    return fetchApi('/api/repositories/scan', {
      method: 'POST',
      body: JSON.stringify({ repositoryPath }),
    });
  },

  /**
   * Re-sync all configured repositories
   */
  async sync(): Promise<{
    success: boolean;
    message: string;
    worktreeCount: number;
    repositoryCount: number;
    repositories: string[];
  }> {
    return fetchApi('/api/repositories/sync', {
      method: 'POST',
    });
  },
};

/**
 * Helper to handle API errors in components
 */
export function handleApiError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unknown error occurred';
}
