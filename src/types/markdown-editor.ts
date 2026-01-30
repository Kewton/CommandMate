/**
 * Type definitions for markdown editor feature
 *
 * @module types/markdown-editor
 */

/**
 * View mode for markdown editor
 * - split: Show both editor and preview side by side
 * - editor: Show only the editor
 * - preview: Show only the preview
 */
export type ViewMode = 'split' | 'editor' | 'preview';

/**
 * Strategy configuration for each view mode
 * Used to determine which panels to show and their widths
 */
export interface ViewModeStrategy {
  /** Whether to show the editor panel */
  showEditor: boolean;
  /** Whether to show the preview panel */
  showPreview: boolean;
  /** Tailwind width class for editor (e.g., 'w-1/2', 'w-full', 'w-0') */
  editorWidth: string;
  /** Tailwind width class for preview (e.g., 'w-1/2', 'w-full', 'w-0') */
  previewWidth: string;
}

/**
 * View mode strategies lookup
 */
export const VIEW_MODE_STRATEGIES: Record<ViewMode, ViewModeStrategy> = {
  split: {
    showEditor: true,
    showPreview: true,
    editorWidth: 'w-1/2',
    previewWidth: 'w-1/2',
  },
  editor: {
    showEditor: true,
    showPreview: false,
    editorWidth: 'w-full',
    previewWidth: 'w-0',
  },
  preview: {
    showEditor: false,
    showPreview: true,
    editorWidth: 'w-0',
    previewWidth: 'w-full',
  },
};

/**
 * Editor state for managing markdown content
 */
export interface EditorState {
  /** Current editor content */
  content: string;
  /** Original content when file was loaded (for dirty state detection) */
  originalContent: string;
  /** Whether there are unsaved changes */
  isDirty: boolean;
  /** Current file path (relative to worktree root) */
  filePath: string;
  /** Whether the editor is loading content */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
}

/**
 * Props for MarkdownEditor component
 */
export interface EditorProps {
  /** Worktree ID for API calls */
  worktreeId: string;
  /** File path relative to worktree root */
  filePath: string;
  /** Callback when editor is closed */
  onClose?: () => void;
  /** Callback when file is saved successfully */
  onSave?: (filePath: string) => void;
  /** Optional initial view mode */
  initialViewMode?: ViewMode;
}

/**
 * Toast notification type
 */
export type ToastType = 'success' | 'error' | 'info';

/**
 * Toast notification item
 */
export interface ToastItem {
  /** Unique identifier for the toast */
  id: string;
  /** Message to display */
  message: string;
  /** Toast type determines styling */
  type: ToastType;
  /** Optional duration in milliseconds (default: 3000, 0 = no auto-dismiss) */
  duration?: number;
}

/**
 * File operation request types
 */
export interface FileOperationRequest {
  /** Type of item to create */
  type?: 'file' | 'directory';
  /** File content (for file creation/update) */
  content?: string;
  /** Action type (for PATCH requests) */
  action?: 'rename';
  /** New name for rename operation */
  newName?: string;
}

/**
 * File operation response
 */
export interface FileOperationResponse {
  /** Whether the operation was successful */
  success: boolean;
  /** Path of the affected file/directory (on success) */
  path?: string;
  /** File content (for GET requests) */
  content?: string;
  /** Error information (on failure) */
  error?: {
    /** Error code (e.g., 'FILE_NOT_FOUND', 'INVALID_PATH') */
    code: string;
    /** Human-readable error message */
    message: string;
  };
}

/**
 * Context menu item
 */
export interface ContextMenuItem {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Icon component or name */
  icon?: React.ReactNode;
  /** Click handler */
  onClick: () => void;
  /** Whether the item is disabled */
  disabled?: boolean;
  /** Whether to show a separator after this item */
  dividerAfter?: boolean;
  /** Item variant for styling */
  variant?: 'default' | 'danger';
}

/**
 * Context menu state
 */
export interface ContextMenuState {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Menu position */
  position: { x: number; y: number };
  /** Target file/directory path */
  targetPath: string | null;
  /** Target type */
  targetType: 'file' | 'directory' | null;
}

/**
 * Local storage key for view mode persistence
 */
export const LOCAL_STORAGE_KEY = 'commandmate:md-editor-view-mode';

/**
 * Local storage key for split ratio persistence
 */
export const LOCAL_STORAGE_KEY_SPLIT_RATIO = 'commandmate:md-editor-split-ratio';

/**
 * Local storage key for maximized state persistence
 */
export const LOCAL_STORAGE_KEY_MAXIMIZED = 'commandmate:md-editor-maximized';

/**
 * Default debounce delay for preview updates (in milliseconds)
 */
export const PREVIEW_DEBOUNCE_MS = 300;

/**
 * File size thresholds
 */
export const FILE_SIZE_LIMITS = {
  /** Warning threshold (500KB) */
  WARNING_THRESHOLD: 500 * 1024,
  /** Maximum file size (1MB) */
  MAX_SIZE: 1024 * 1024,
} as const;

/**
 * Default split ratio (50:50)
 */
export const DEFAULT_SPLIT_RATIO = 0.5;

/**
 * Minimum split ratio (10%)
 */
export const MIN_SPLIT_RATIO = 0.1;

/**
 * Maximum split ratio (90%)
 */
export const MAX_SPLIT_RATIO = 0.9;

/**
 * Editor layout state for managing display modes
 */
export interface EditorLayoutState {
  /** Current view mode */
  viewMode: ViewMode;
  /** Whether the editor is maximized (fullscreen) */
  isMaximized: boolean;
  /** Split ratio for split view (0.0-1.0, representing editor width percentage) */
  splitRatio: number;
}

/**
 * Default editor layout state
 */
export const DEFAULT_LAYOUT_STATE: EditorLayoutState = {
  viewMode: 'split',
  isMaximized: false,
  splitRatio: DEFAULT_SPLIT_RATIO,
};

/**
 * Validate split ratio value
 * @param value - Value to validate
 * @returns true if valid split ratio (0.1-0.9)
 */
export function isValidSplitRatio(value: unknown): value is number {
  return typeof value === 'number' && value >= MIN_SPLIT_RATIO && value <= MAX_SPLIT_RATIO;
}

/**
 * Validate boolean value from localStorage
 * @param value - Value to validate
 * @returns true if valid boolean
 */
export function isValidBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}
