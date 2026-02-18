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
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
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
        bgColor: 'bg-green-50',
        borderColor: 'border-green-200',
        textColor: 'text-green-800',
        iconColor: 'text-green-500',
      };
    case 'error':
      return {
        bgColor: 'bg-red-50',
        borderColor: 'border-red-200',
        textColor: 'text-red-800',
        iconColor: 'text-red-500',
      };
    case 'info':
    default:
      return {
        bgColor: 'bg-blue-50',
        borderColor: 'border-blue-200',
        textColor: 'text-blue-800',
        iconColor: 'text-blue-500',
      };
  }
}

/**
 * Get icon component based on type
 * [REFACTOR] Performance: Accepts iconColor as prop to avoid duplicate getToastStyles call
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
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const styles = getToastStyles(type);

  useEffect(() => {
    // Set up auto-dismiss if duration > 0
    if (duration > 0) {
      timeoutRef.current = setTimeout(() => {
        onClose(id);
      }, duration);
    }

    // Cleanup timeout on unmount
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [id, duration, onClose]);

  const handleClose = useCallback(() => {
    // Clear timeout if manually closed
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    onClose(id);
  }, [id, onClose]);

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
        animate-slide-in
      `}
    >
      <ToastIcon type={type} iconColor={styles.iconColor} />
      <p className="flex-1 text-sm font-medium">{message}</p>
      <button
        data-testid="toast-close-button"
        onClick={handleClose}
        aria-label="Close notification"
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
