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

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options?.headers,
    };

    // Add Bearer token if available
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
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
   * Get messages for a worktree
   */
  async getMessages(id: string): Promise<ChatMessage[]> {
    return fetchApi<ChatMessage[]>(`/api/worktrees/${id}/messages`);
  },

  /**
   * Send a message to a worktree
   */
  async sendMessage(id: string, content: string): Promise<{ success: boolean }> {
    return fetchApi<{ success: boolean }>(`/api/worktrees/${id}/send`, {
      method: 'POST',
      body: JSON.stringify({ content }),
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
   */
  async killSession(id: string): Promise<{ success: boolean; message: string }> {
    return fetchApi<{ success: boolean; message: string }>(
      `/api/worktrees/${id}/kill-session`,
      { method: 'POST' }
    );
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
