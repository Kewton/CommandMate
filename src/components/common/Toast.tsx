/**
 * Toast notification component
 *
 * Provides toast notifications with success/error/info display,
 * auto-dismiss functionality, and manual close button.
 *
 * @module components/common/Toast
 */

'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
import { EXIT_ANIMATION_DURATION_MS } from '@/config/ui-feedback-config';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import type { ToastType, ToastItem } from '@/types/markdown-editor';

/** Default duration for auto-dismiss (3 seconds) */
const DEFAULT_DURATION = 3000;

/**
 * A queued toast, optionally actionable (Issue #1788).
 *
 * Extends the shared {@link ToastItem} here rather than in
 * `types/markdown-editor` because the action is a live function, not
 * serializable editor state — and every existing `ToastItem` is still a valid
 * value of this type.
 */
export interface AppToastItem extends ToastItem {
  /** Invoked when the body is activated. Absent = a plain, inert toast. */
  onClick?: () => void;
}

/** Extra behavior for {@link ToastContextValue.showToast}. */
export interface ShowToastOptions {
  /**
   * Makes the toast body a button that runs this and dismisses the toast —
   * "<branch> is waiting for you" is only useful if it takes you there.
   */
  onClick?: () => void;
}

/**
 * Props for individual Toast component
 */
export interface ToastProps {
  /** Unique identifier for the toast */
  id: string;
  /** Message to display */
  message: string;
  /** Toast type determines styling */
  type: ToastType;
  /** Callback when toast is closed */
  onClose: (id: string) => void;
  /** Optional duration in milliseconds (default: 3000, 0 = no auto-dismiss) */
  duration?: number;
  /**
   * Optional activation handler (Issue #1788).
   *
   * When present the message becomes a real `<button>`, not a `div` with an
   * onClick: the toast has to be reachable by keyboard and by touch, and a
   * hover-or-pointer-only affordance would be dead on a phone — which is the
   * device this Issue's toast most needs to work on.
   */
  onClick?: () => void;
}

/**
 * Get toast styles based on type
 */
function getToastStyles(type: ToastType): {
  bgColor: string;
  borderColor: string;
  textColor: string;
  iconColor: string;
} {
  switch (type) {
    case 'success':
      return {
        bgColor: 'bg-success-subtle',
        borderColor: 'border-success-border',
        textColor: 'text-success-foreground',
        iconColor: 'text-success-foreground',
      };
    case 'error':
      return {
        bgColor: 'bg-danger-subtle',
        borderColor: 'border-danger-border',
        textColor: 'text-danger-foreground',
        iconColor: 'text-danger-foreground',
      };
    case 'warning':
      return {
        bgColor: 'bg-warning-subtle',
        borderColor: 'border-warning-border',
        textColor: 'text-warning-foreground',
        iconColor: 'text-warning-foreground',
      };
    case 'info':
    default:
      return {
        bgColor: 'bg-info-subtle',
        borderColor: 'border-info-border',
        textColor: 'text-info-foreground',
        iconColor: 'text-info-foreground',
      };
  }
}

/**
 * Get icon component based on type.
 * Accepts iconColor as prop to avoid duplicate getToastStyles call.
 */
function ToastIcon({ type, iconColor }: { type: ToastType; iconColor: string }) {
  const iconClass = `h-5 w-5 ${iconColor}`;

  switch (type) {
    case 'success':
      return (
        <CheckCircle
          className={iconClass}
          data-testid="toast-icon-success"
        />
      );
    case 'error':
      return (
        <XCircle
          className={iconClass}
          data-testid="toast-icon-error"
        />
      );
    case 'warning':
      return (
        <AlertTriangle
          className={iconClass}
          data-testid="toast-icon-warning"
        />
      );
    case 'info':
    default:
      return (
        <Info
          className={iconClass}
          data-testid="toast-icon-info"
        />
      );
  }
}

/**
 * Individual Toast component
 *
 * @example
 * ```tsx
 * <Toast
 *   id="toast-1"
 *   message="File saved successfully"
 *   type="success"
 *   onClose={handleClose}
 * />
 * ```
 */
export function Toast({
  id,
  message,
  type,
  onClose,
  duration = DEFAULT_DURATION,
  onClick,
}: ToastProps) {
  const t = useTranslations('common');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const styles = getToastStyles(type);

  // [Issue #1114] Exit animation: closing (auto or manual) only flips local
  // `open` state; onClose (which unmounts the toast via the parent list) is
  // deferred until the fade+slide-out window has played.
  const [open, setOpen] = useState(true);
  const { shouldRender, isExiting } = useExitAnimation(
    open,
    EXIT_ANIMATION_DURATION_MS
  );

  // Notify the parent once the exit window elapsed. onClose is read through a
  // ref so an unstable callback identity cannot re-fire the notification.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!shouldRender) {
      onCloseRef.current(id);
    }
  }, [shouldRender, id]);

  useEffect(() => {
    // Set up auto-dismiss if duration > 0
    if (duration > 0) {
      timeoutRef.current = setTimeout(() => {
        setOpen(false);
      }, duration);
    }

    // Cleanup timeout on unmount
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [duration]);

  const handleClose = useCallback(() => {
    // Clear timeout if manually closed
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setOpen(false);
  }, []);

  return (
    <div
      data-testid={`toast-${id}`}
      role="alert"
      className={`
        ${styles.bgColor}
        ${styles.borderColor}
        ${styles.textColor}
        border rounded-lg shadow-lg p-4 min-w-[300px] max-w-[400px]
        flex items-start gap-3
        ${
          isExiting
            ? 'animate-out fade-out-0 slide-out-to-right-full duration-200 fill-mode-forwards pointer-events-none'
            : 'animate-slide-in'
        }
      `}
    >
      <ToastIcon type={type} iconColor={styles.iconColor} />
      {onClick ? (
        <button
          type="button"
          data-testid="toast-action-button"
          onClick={() => {
            onClick();
            handleClose();
          }}
          className="flex-1 text-left text-sm font-medium underline-offset-2 hover:underline
            focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          {message}
        </button>
      ) : (
        <p className="flex-1 text-sm font-medium">{message}</p>
      )}
      <button
        data-testid="toast-close-button"
        onClick={handleClose}
        aria-label={t('closeNotification')}
        className={`
          ${styles.textColor}
          hover:opacity-70
          focus:outline-none focus:ring-2 focus:ring-offset-2
          transition-opacity
        `}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Props for ToastContainer component
 */
export interface ToastContainerProps {
  /** Array of toast items to display */
  toasts: AppToastItem[];
  /** Callback when a toast is closed */
  onClose: (id: string) => void;
}

/**
 * Container component for managing multiple toasts
 *
 * @example
 * ```tsx
 * <ToastContainer toasts={toasts} onClose={removeToast} />
 * ```
 */
export function ToastContainer({ toasts, onClose }: ToastContainerProps) {
  // [Issue #1399] Render through a portal to `document.body` so the container's
  // `position: fixed` resolves against the viewport. When mounted inside a
  // transformed ancestor (AppShell's `<aside data-testid="sidebar-container">`
  // uses a transform), that ancestor becomes the containing block for `fixed`,
  // pinning the toasts to the sidebar's box and clipping their left edge instead
  // of the intended bottom-right of the screen. Guarded on `mounted` so the
  // server render (where `document` is absent) yields null and the portal only
  // appears after client hydration — the same pattern as CommandPalette / Modal.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const container = (
    <div
      data-testid="toast-container"
      aria-live="polite"
      className="fixed bottom-4 right-4 flex flex-col gap-2"
      style={{ zIndex: Z_INDEX.TOAST }}
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          id={toast.id}
          message={toast.message}
          type={toast.type}
          onClose={onClose}
          duration={toast.duration}
          onClick={toast.onClick}
        />
      ))}
    </div>
  );

  if (!mounted) return null;

  return createPortal(container, document.body);
}

/**
 * Shared shape for the toast controls returned by {@link useToast} and provided
 * by {@link ToastProvider}.
 */
export interface ToastContextValue {
  /** Currently visible toasts */
  toasts: AppToastItem[];
  /** Show a new toast notification; returns the generated id */
  showToast: (
    message: string,
    type?: ToastType,
    duration?: number,
    options?: ShowToastOptions,
  ) => string;
  /** Remove a toast by id */
  removeToast: (id: string) => void;
  /** Clear all toasts */
  clearToasts: () => void;
}

/**
 * Internal state machine for toast notifications. Backs both the shared
 * {@link ToastProvider} and the provider-less fallback in {@link useToast}.
 */
function useToastState(): ToastContextValue {
  const [toasts, setToasts] = useState<AppToastItem[]>([]);
  const idCounterRef = useRef(0);

  const showToast = useCallback(
    (
      message: string,
      type: ToastType = 'info',
      duration: number = DEFAULT_DURATION,
      options?: ShowToastOptions,
    ) => {
      const id = `toast-${++idCounterRef.current}-${Date.now()}`;
      const newToast: AppToastItem = {
        id,
        message,
        type,
        duration,
        ...(options?.onClick ? { onClick: options.onClick } : {}),
      };
      setToasts((prev) => [...prev, newToast]);
      return id;
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  return useMemo(
    () => ({ toasts, showToast, removeToast, clearToasts }),
    [toasts, showToast, removeToast, clearToasts]
  );
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * ToastProvider (Issue #1400)
 *
 * Holds a single app-wide toast queue and renders the one and only
 * <ToastContainer> (portaled to `document.body`, per Issue #1399, so it escapes
 * any transformed ancestor and pins to the viewport's bottom-right). Mount it
 * once above the app (see AppProviders); every useToast() below then shares the
 * same queue instead of spawning its own detached container.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const value = useToastState();
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={value.toasts} onClose={value.removeToast} />
    </ToastContext.Provider>
  );
}

/**
 * Hook for showing toast notifications.
 *
 * Returns the shared controls from the nearest {@link ToastProvider} (the normal
 * case — AppProviders mounts one globally, so a single container renders every
 * toast). With no provider above it falls back to a local, self-contained
 * instance so isolated components/tests still work; render your own
 * <ToastContainer> in that case.
 *
 * @example
 * ```tsx
 * function SaveButton() {
 *   const { showToast } = useToast();
 *   return <button onClick={() => showToast('Saved', 'success')}>Save</button>;
 * }
 * ```
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  const local = useToastState();
  return ctx ?? local;
}

// Re-export types for convenience
export type { ToastType, ToastItem };
