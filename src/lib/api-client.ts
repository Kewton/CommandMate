/**
 * API Client Utilities
 * Type-safe fetch wrapper for backend API calls
 */

import type { Worktree, ChatMessage, WorktreeMemo } from '@/types/models';
import type { SlashCommandGroup } from '@/types/slash-commands';

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
    public data?: unknown
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
    const headers = new Headers(options?.headers);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(url, {
      ...options,
      headers,
    });

    // Detect auth redirect: fetch follows 307 to /login, returning HTML with 200.
    // Check content-type to avoid parsing HTML as JSON.
    const contentType = response.headers.get('content-type') || '';
    if (response.redirected && response.url.includes('/login')) {
      throw new ApiError('Authentication required', 401);
    }

    if (!response.ok) {
      const errorBody = contentType.includes('application/json')
        ? await response.json().catch(() => ({})) as { error?: string }
        : {} as { error?: string };
      throw new ApiError(
        errorBody.error || `HTTP error ${response.status}`,
        response.status,
        errorBody
      );
    }

    if (!contentType.includes('application/json')) {
      throw new ApiError('Unexpected response format', response.status);
    }

    return response.json();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      error instanceof Error ? error.message : 'Unknown error',
      0,
      error
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
   * Update worktree description
   */
  async updateDescription(id: string, description: string): Promise<Worktree> {
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description }),
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
    return fetchApi<Worktree>(`/api/worktrees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ cliToolId }),
    });
  },

  /**
   * Mark worktree as viewed (for unread tracking - Issue #31)
   * Updates last_viewed_at timestamp to current time
   */
  async markAsViewed(id: string): Promise<{ success: boolean }> {
    return fetchApi<{ success: boolean }>(`/api/worktrees/${id}/viewed`, {
      method: 'PATCH',
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
   * @param id - Worktree ID
   * @param filename - Log filename
   * @param options - Optional parameters (sanitize: apply privacy sanitization)
   */
  async getLogFile(id: string, filename: string, options?: { sanitize?: boolean }): Promise<{
    filename: string;
    cliToolId: string;
    content: string;
    size: number;
    modifiedAt: string;
  }> {
    const queryParams = options?.sanitize ? '?sanitize=true' : '';
    return fetchApi(`/api/worktrees/${id}/logs/${filename}${queryParams}`);
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
 * Excluded repository from API
 * Issue #190: Repository exclusion on sync
 */
export interface ExcludedRepository {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  cloneSource: string;
  isEnvManaged: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Delete repository response type
 */
export interface DeleteRepositoryResponse {
  success: boolean;
  deletedWorktreeCount: number;
  deletedWorktreeIds: string[];
  warnings?: string[];
}

/**
 * Clone job start response type
 * Issue #71: Clone URL registration feature
 */
export interface CloneStartResponse {
  success: true;
  jobId: string;
  status: 'pending';
  message: string;
}

/**
 * Clone job status response type
 * Issue #71: Clone URL registration feature
 */
export interface CloneStatusResponse {
  success: true;
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  repositoryId?: string;
  error?: {
    category: string;
    code: string;
    message: string;
  };
}

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

  /**
   * Delete a repository and all its worktrees
   * Issue #69: Repository delete feature
   *
   * @param repositoryPath - Path of the repository to delete
   * @returns Delete result with count and any warnings
   */
  async delete(repositoryPath: string): Promise<DeleteRepositoryResponse> {
    return fetchApi<DeleteRepositoryResponse>('/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath }),
    });
  },

  /**
   * Start a clone job for a remote repository
   * Issue #71: Clone URL registration feature
   *
   * @param cloneUrl - Git clone URL (HTTPS or SSH)
   * @returns Clone job response with job ID
   */
  async clone(cloneUrl: string): Promise<CloneStartResponse> {
    return fetchApi<CloneStartResponse>('/api/repositories/clone', {
      method: 'POST',
      body: JSON.stringify({ cloneUrl }),
    });
  },

  /**
   * Get the status of a clone job
   * Issue #71: Clone URL registration feature
   *
   * @param jobId - Clone job ID
   * @returns Clone job status
   */
  async getCloneStatus(jobId: string): Promise<CloneStatusResponse> {
    return fetchApi<CloneStatusResponse>(`/api/repositories/clone/${jobId}`);
  },

  /**
   * Get excluded (disabled) repositories
   * Issue #190: Repository exclusion on sync
   *
   * @returns List of excluded repositories
   */
  async getExcluded(): Promise<{ success: boolean; repositories: ExcludedRepository[] }> {
    return fetchApi('/api/repositories/excluded');
  },

  /**
   * Restore an excluded repository
   * Issue #190: Repository exclusion on sync
   *
   * @param repositoryPath - Path of the repository to restore
   * @returns Restore result with worktree count
   */
  async restore(repositoryPath: string): Promise<{
    success: boolean;
    worktreeCount: number;
    message?: string;
    warning?: string;
  }> {
    return fetchApi('/api/repositories/restore', {
      method: 'PUT',
      body: JSON.stringify({ repositoryPath }),
    });
  },
};

/**
 * Slash Commands API response
 */
export interface SlashCommandsResponse {
  groups: SlashCommandGroup[];
}

/**
 * Slash Command API client
 */
export const slashCommandApi = {
  /**
   * Get all slash commands grouped by category
   */
  async getAll(): Promise<SlashCommandsResponse> {
    return fetchApi<SlashCommandsResponse>('/api/slash-commands');
  },
};

/**
 * Memo API response types
 */
export interface MemosResponse {
  memos: WorktreeMemo[];
}

export interface MemoResponse {
  memo: WorktreeMemo;
}

/**
 * Memo creation request body
 */
export interface CreateMemoRequest {
  title?: string;
  content?: string;
}

/**
 * Memo update request body
 */
export interface UpdateMemoRequest {
  title?: string;
  content?: string;
}

/**
 * Memo API client
 * CRUD operations for worktree memos
 */
export const memoApi = {
  /**
   * Get all memos for a worktree
   * @param worktreeId - ID of the worktree
   * @returns List of memos sorted by position
   */
  async getAll(worktreeId: string): Promise<WorktreeMemo[]> {
    const response = await fetchApi<MemosResponse>(`/api/worktrees/${worktreeId}/memos`);
    return response.memos;
  },

  /**
   * Create a new memo for a worktree
   * @param worktreeId - ID of the worktree
   * @param data - Memo data (title, content)
   * @returns Created memo
   */
  async create(worktreeId: string, data?: CreateMemoRequest): Promise<WorktreeMemo> {
    const response = await fetchApi<MemoResponse>(`/api/worktrees/${worktreeId}/memos`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
    return response.memo;
  },

  /**
   * Update an existing memo
   * @param worktreeId - ID of the worktree
   * @param memoId - ID of the memo to update
   * @param data - Fields to update (title and/or content)
   * @returns Updated memo
   */
  async update(worktreeId: string, memoId: string, data: UpdateMemoRequest): Promise<WorktreeMemo> {
    const response = await fetchApi<MemoResponse>(
      `/api/worktrees/${worktreeId}/memos/${memoId}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return response.memo;
  },

  /**
   * Delete a memo
   * @param worktreeId - ID of the worktree
   * @param memoId - ID of the memo to delete
   * @returns Success status
   */
  async delete(worktreeId: string, memoId: string): Promise<{ success: boolean }> {
    return fetchApi<{ success: boolean }>(
      `/api/worktrees/${worktreeId}/memos/${memoId}`,
      { method: 'DELETE' }
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

/**
 * Update check response type
 * Issue #257: Version update notification feature
 */
export interface UpdateCheckResponse {
  status: 'success' | 'degraded';
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  installType: 'global' | 'local' | 'unknown';
  updateCommand: string | null;
}

/**
 * App-level API client
 * Issue #257: Application-wide endpoints (not worktree-specific)
 */
export const appApi = {
  /**
   * Check for application updates via GitHub Releases API.
   * Issue #257: Version update notification feature
   *
   * Note: fetchApi attaches Content-Type: application/json to all requests
   * including GET (CONS-004, IMP-SF-001). This is functionally harmless for
   * GET requests. Future developers: be aware of this behavior when adding
   * POST endpoints to /api/app/
   *
   * @returns Update check response with version info and install type
   */
  async checkForUpdate(): Promise<UpdateCheckResponse> {
    return fetchApi<UpdateCheckResponse>('/api/app/update-check', {
      method: 'GET',
    });
  },
};

