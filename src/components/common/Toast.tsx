/**
 * Toast notification component
 *
 * Provides toast notifications with success/error/info display,
 * auto-dismiss functionality, and manual close button.
 *
 * @module components/common/Toast
 */

'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
import { EXIT_ANIMATION_DURATION_MS } from '@/config/ui-feedback-config';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import type { ToastType, ToastItem } from '@/types/markdown-editor';

/** Default duration for auto-dismiss (3 seconds) */
const DEFAULT_DURATION = 3000;

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
      <p className="flex-1 text-sm font-medium">{message}</p>
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
  toasts: ToastItem[];
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
  return (
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
        />
      ))}
    </div>
  );
}

/**
 * Hook for managing toast notifications
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { showToast, toasts, removeToast } = useToast();
 *
 *   const handleSave = () => {
 *     showToast('File saved successfully', 'success');
 *   };
 *
 *   return (
 *     <>
 *       <button onClick={handleSave}>Save</button>
 *       <ToastContainer toasts={toasts} onClose={removeToast} />
 *     </>
 *   );
 * }
 * ```
 */
export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idCounterRef = useRef(0);

  /**
   * Show a new toast notification
   */
  const showToast = useCallback(
    (message: string, type: ToastType = 'info', duration: number = DEFAULT_DURATION) => {
      const id = `toast-${++idCounterRef.current}-${Date.now()}`;
      const newToast: ToastItem = {
        id,
        message,
        type,
        duration,
      };
      setToasts((prev) => [...prev, newToast]);
      return id;
    },
    []
  );

  /**
   * Remove a toast by ID
   */
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  /**
   * Clear all toasts
   */
  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  return {
    toasts,
    showToast,
    removeToast,
    clearToasts,
  };
}

// Re-export types for convenience
export type { ToastType, ToastItem };
